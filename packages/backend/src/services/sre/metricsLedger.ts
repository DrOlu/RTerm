import type { ResourceSnapshot } from '../../types'

/**
 * MetricsLedger — a time-series store for resource-monitor snapshots (Tier 1 SRE).
 *
 * Persists a compact, flattened metric point per snapshot per host so trends,
 * capacity forecasts, SLO/SLI computation, and golden-signal dashboards are
 * possible. Pure + injectable: callers feed it `ResourceSnapshot`s (from
 * ResourceMonitorService) and query points/series/trends. Storage is injected
 * (in-memory by default; a SQLite-backed store can wrap it).
 */

export interface MetricPoint {
  host: string
  at: number
  cpuUsagePercent?: number
  memoryUsagePercent?: number
  loadAvg1?: number
  /** max disk usagePercent across mounts (worst-case disk pressure). */
  diskUsagePercentMax?: number
  netRxBytesPerSec?: number
  netTxBytesPerSec?: number
  gpuUsagePercent?: number
  processCount?: number
  uptimeSeconds?: number
}

export interface MetricSeries {
  host: string
  metric: keyof Omit<MetricPoint, 'host' | 'at'>
  points: Array<{ at: number; value: number }>
}

export interface MetricsLedgerOptions {
  /** max points retained per host (ring buffer; default 10_000). */
  perHostLimit?: number
  now?: () => number
}

const DEFAULT_LIMIT = 10_000

/** Flatten a ResourceSnapshot into a MetricPoint (pure). */
export function flattenSnapshot(host: string, snap: ResourceSnapshot): MetricPoint {
  const p: MetricPoint = { host, at: snap.timestamp }
  if (snap.cpu && typeof snap.cpu.usagePercent === 'number') p.cpuUsagePercent = snap.cpu.usagePercent
  if (snap.memory && typeof snap.memory.usagePercent === 'number') p.memoryUsagePercent = snap.memory.usagePercent
  if (Array.isArray(snap.loadAverage) && typeof snap.loadAverage[0] === 'number') p.loadAvg1 = snap.loadAverage[0]
  if (Array.isArray(snap.disks) && snap.disks.length > 0) {
    p.diskUsagePercentMax = Math.max(...snap.disks.map((d) => d.usagePercent ?? 0))
  }
  if (Array.isArray(snap.network) && snap.network.length > 0) {
    p.netRxBytesPerSec = snap.network.reduce((s, n) => s + (n.rxBytesPerSec ?? 0), 0)
    p.netTxBytesPerSec = snap.network.reduce((s, n) => s + (n.txBytesPerSec ?? 0), 0)
  }
  if (Array.isArray(snap.gpus) && snap.gpus.length > 0) {
    p.gpuUsagePercent = Math.max(...snap.gpus.map((g) => g.utilizationPercent ?? 0))
  }
  if (Array.isArray(snap.processes)) p.processCount = snap.processes.length
  if (typeof snap.uptimeSeconds === 'number') p.uptimeSeconds = snap.uptimeSeconds
  return p
}

export class MetricsLedger {
  private readonly points = new Map<string, MetricPoint[]>()
  private readonly perHostLimit: number

  constructor(opts: MetricsLedgerOptions = {}) {
    this.perHostLimit = opts.perHostLimit ?? DEFAULT_LIMIT
  }

  /** Ingest a resource snapshot for a host. Returns the stored point. */
  record(host: string, snap: ResourceSnapshot): MetricPoint {
    const p = flattenSnapshot(host, snap)
    this.recordPoint(p)
    return p
  }

  /** Ingest a pre-flattened point. */
  recordPoint(p: MetricPoint): void {
    let arr = this.points.get(p.host)
    if (!arr) { arr = []; this.points.set(p.host, arr) }
    arr.push(p)
    if (arr.length > this.perHostLimit) arr.splice(0, arr.length - this.perHostLimit)
  }

  /** All hosts with any recorded points. */
  hosts(): string[] {
    return Array.from(this.points.keys())
  }

  /** Points for a host, optionally filtered to [sinceMs, untilMs]. */
  series(host: string, opts: { sinceMs?: number; untilMs?: number } = {}): MetricPoint[] {
    const arr = this.points.get(host) ?? []
    return arr.filter((p) =>
      (opts.sinceMs === undefined || p.at >= opts.sinceMs) &&
      (opts.untilMs === undefined || p.at <= opts.untilMs),
    )
  }

  /** A single-metric series for a host. */
  metricSeries(host: string, metric: keyof Omit<MetricPoint, 'host' | 'at'>, opts: { sinceMs?: number; untilMs?: number } = {}): MetricSeries {
    const pts = this.series(host, opts)
      .map((p) => ({ at: p.at, value: p[metric] as number | undefined }))
      .filter((x): x is { at: number; value: number } => typeof x.value === 'number')
    return { host, metric, points: pts }
  }

  /** Latest point for a host (or undefined). */
  latest(host: string): MetricPoint | undefined {
    const arr = this.points.get(host)
    return arr && arr.length > 0 ? arr[arr.length - 1] : undefined
  }

  /** Simple linear-trend slope (units/day) for a metric over a window, using
   * least-squares over the series. Positive = rising. */
  trendSlopePerDay(host: string, metric: keyof Omit<MetricPoint, 'host' | 'at'>, opts: { sinceMs?: number } = {}): number | undefined {
    const s = this.metricSeries(host, metric, opts)
    if (s.points.length < 3) return undefined
    const t0 = s.points[0].at
    const xs = s.points.map((p) => (p.at - t0) / 86_400_000) // days
    const ys = s.points.map((p) => p.value)
    const n = xs.length
    const meanX = xs.reduce((a, b) => a + b, 0) / n
    const meanY = ys.reduce((a, b) => a + b, 0) / n
    let num = 0, den = 0
    for (let i = 0; i < n; i += 1) {
      num += (xs[i] - meanX) * (ys[i] - meanY)
      den += (xs[i] - meanX) * (xs[i] - meanX)
    }
    if (den === 0) return undefined
    return num / den
  }

  /** Days until a metric crosses a threshold given the current value + slope.
   * Returns undefined when not computable (no slope, flat, or moving away). */
  daysUntilThreshold(host: string, metric: keyof Omit<MetricPoint, 'host' | 'at'>, threshold: number): number | undefined {
    const latest = this.latest(host)
    if (!latest) return undefined
    const cur = latest[metric] as number | undefined
    if (typeof cur !== 'number') return undefined
    const slope = this.trendSlopePerDay(host, metric)
    if (slope === undefined || slope <= 0) return undefined
    const gap = threshold - cur
    if (gap <= 0) return 0
    return gap / slope
  }

  /** Remove all points (test helper / reset). */
  clear(): void {
    this.points.clear()
  }
}
