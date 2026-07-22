import type { MetricsLedger } from './metricsLedger'

/**
 * GoldenSignals — Tier 3 SRE: latency, traffic, errors, saturation per host,
 * derived from the metrics ledger (plus optional latency/error sources), and
 * capacity forecasting (trend + days-to-threshold).
 *
 * Pure + injectable: reads from the injected MetricsLedger; latency/error data
 * comes from injected providers (e.g. synthetic-check results, health probes).
 */

export interface GoldenSignalReport {
  host: string
  at: number
  /** saturation: cpu/mem/disk usage % (latest). */
  cpuPercent?: number
  memPercent?: number
  diskPercentMax?: number
  /** traffic: net throughput B/s (latest). */
  netRxBps?: number
  netTxBps?: number
  /** latency: p50/p95/p99 ms when a latency series is provided. */
  latencyP50Ms?: number
  latencyP95Ms?: number
  latencyP99Ms?: number
  /** errors: error rate fraction (0..1) when an error source is provided. */
  errorRate?: number
  /** capacity: days until disk hits the threshold (from the ledger trend). */
  diskDaysToFull?: number
  cpuTrendPerDay?: number
  memTrendPerDay?: number
}

export interface LatencySample { at: number; ms: number }
export interface GoldenSignalsDeps {
  ledger: MetricsLedger
  /** optional latency series provider (e.g. from synthetic checks). */
  latencyFor?: (host: string, sinceMs: number) => LatencySample[]
  /** optional error-rate provider (fraction 0..1 over the window). */
  errorRateFor?: (host: string, sinceMs: number) => number | undefined
  now?: () => number
  /** lookback window for latency/error (default 1h). */
  windowMs?: number
}

const DEFAULT_WINDOW = 3_600_000

export function percentile(sorted: number[], p: number): number | undefined {
  if (sorted.length === 0) return undefined
  // Nearest-rank method: for p50 with N elements, the rank is ceil(N * p/100),
  // clamped to [1, N], then converted to a 0-based index.
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length))
  return sorted[Math.min(rank, sorted.length) - 1]
}

export class GoldenSignals {
  private readonly now: () => number
  private readonly windowMs: number

  constructor(private readonly deps: GoldenSignalsDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.windowMs = deps.windowMs ?? DEFAULT_WINDOW
  }

  /** Build the golden-signal report for one host. */
  report(host: string, opts: { diskFullThresholdPercent?: number } = {}): GoldenSignalReport {
    const latest = this.deps.ledger.latest(host)
    const now = this.now()
    const since = now - this.windowMs

    const r: GoldenSignalReport = { host, at: now }
    if (latest) {
      r.cpuPercent = latest.cpuUsagePercent
      r.memPercent = latest.memoryUsagePercent
      r.diskPercentMax = latest.diskUsagePercentMax
      r.netRxBps = latest.netRxBytesPerSec
      r.netTxBps = latest.netTxBytesPerSec
    }

    if (this.deps.latencyFor) {
      const samples = this.deps.latencyFor(host, since).map((s) => s.ms).sort((a, b) => a - b)
      if (samples.length > 0) {
        r.latencyP50Ms = percentile(samples, 50)
        r.latencyP95Ms = percentile(samples, 95)
        r.latencyP99Ms = percentile(samples, 99)
      }
    }

    if (this.deps.errorRateFor) {
      r.errorRate = this.deps.errorRateFor(host, since)
    }

    const diskThreshold = opts.diskFullThresholdPercent ?? 95
    r.diskDaysToFull = this.deps.ledger.daysUntilThreshold(host, 'diskUsagePercentMax', diskThreshold)
    r.cpuTrendPerDay = this.deps.ledger.trendSlopePerDay(host, 'cpuUsagePercent')
    r.memTrendPerDay = this.deps.ledger.trendSlopePerDay(host, 'memoryUsagePercent')

    return r
  }

  /** Reports for every host in the ledger. */
  reportAll(opts: { diskFullThresholdPercent?: number } = {}): GoldenSignalReport[] {
    return this.deps.ledger.hosts().map((h) => this.report(h, opts))
  }

  /** Capacity forecast table: per host, current disk% and days-to-full. */
  capacityForecast(opts: { diskFullThresholdPercent?: number } = {}): Array<{ host: string; diskPercent?: number; daysToFull?: number }> {
    const threshold = opts.diskFullThresholdPercent ?? 95
    return this.deps.ledger.hosts().map((host) => {
      const latest = this.deps.ledger.latest(host)
      return {
        host,
        diskPercent: latest?.diskUsagePercentMax,
        daysToFull: this.deps.ledger.daysUntilThreshold(host, 'diskUsagePercentMax', threshold),
      }
    })
  }
}
