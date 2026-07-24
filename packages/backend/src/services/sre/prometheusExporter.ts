/**
 * prometheusExporter — render in-repo metrics to Prometheus text exposition
 * format (Tier 1). Lets any Prometheus / OpenMetrics scraper observe RTerm's
 * metrics ledger, golden signals, and AI token usage — closing the
 * "RTerm ingests observability but can't be observed" gap.
 *
 * Pure + injectable: callers register gauges/counters (or feed the metrics
 * ledger), and `render()` produces the `# HELP/# TYPE` text a scraper reads.
 */

export type MetricType = 'gauge' | 'counter'

export interface MetricSample {
  name: string
  help: string
  type: MetricType
  /** label set → value. Use {} for an unlabeled series. */
  samples: Array<{ labels?: Record<string, string>; value: number }>
}

export interface PrometheusRegistryOptions {
  /** metric name prefix (default 'rterm'). */
  prefix?: string
}

const NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/
const LABEL_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/

function escLabelValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"')
}

/** Render a single sample line: `name{k="v",k2="v2"} 42`. */
function renderSampleLine(
  name: string,
  labels: Record<string, string> | undefined,
  value: number,
): string {
  if (!Number.isFinite(value)) return '' // skip NaN/Inf — Prometheus can't store them
  let line = name
  const keys = labels ? Object.keys(labels).sort() : []
  if (keys.length > 0) {
    for (const k of keys) if (!LABEL_RE.test(k)) throw new Error(`invalid label name: ${k}`)
    line += `{${keys.map((k) => `${k}="${escLabelValue(String(labels![k]))}"`).join(',')}}`
  }
  return `${line} ${value}`
}

/** A registry of metrics that renders to Prometheus exposition text. */
export class PrometheusRegistry {
  private readonly metrics = new Map<string, MetricSample>()
  private readonly prefix: string

  constructor(opts: PrometheusRegistryOptions = {}) {
    this.prefix = opts.prefix ?? 'rterm'
  }

  /** Full metric name with prefix applied. */
  private fq(name: string): string {
    if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(name)) throw new Error(`invalid metric name: ${name}`)
    return this.prefix ? `${this.prefix}_${name}` : name
  }

  /** Register/replace a gauge. */
  gauge(name: string, help: string, value: number, labels?: Record<string, string>): void {
    this.set(name, help, 'gauge', [{ labels, value }])
  }

  /** Register/replace a counter. */
  counter(name: string, help: string, value: number, labels?: Record<string, string>): void {
    this.set(name, help, 'counter', [{ labels, value }])
  }

  /** Register/replace a multi-series metric (one sample per label set). */
  set(
    name: string,
    help: string,
    type: MetricType,
    samples: Array<{ labels?: Record<string, string>; value: number }>,
  ): void {
    const fq = this.fq(name)
    if (!NAME_RE.test(fq)) throw new Error(`invalid metric name: ${fq}`)
    if (!help || typeof help !== 'string') throw new Error(`metric ${fq} needs help text`)
    this.metrics.set(fq, { name: fq, help, type, samples })
  }

  /** True if a metric with this (unprefixed) name is registered. */
  has(name: string): boolean {
    return this.metrics.has(this.fq(name))
  }

  /** Remove a metric by unprefixed name. */
  remove(name: string): boolean {
    return this.metrics.delete(this.fq(name))
  }

  /** Number of registered metric families. */
  size(): number {
    return this.metrics.size
  }

  /** Snapshot of all metric families (sorted by name) — for exporters. */
  list(): MetricSample[] {
    return [...this.metrics.values()]
      .map((m) => ({ ...m, samples: m.samples.map((s) => ({ ...s })) }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Render all metrics to Prometheus text exposition format (sorted by name). */
  render(): string {
    const out: string[] = []
    for (const m of [...this.metrics.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      out.push(`# HELP ${m.name} ${m.help}`)
      out.push(`# TYPE ${m.name} ${m.type}`)
      for (const s of m.samples) {
        const line = renderSampleLine(m.name, s.labels, s.value)
        if (line) out.push(line)
      }
    }
    return out.length > 0 ? out.join('\n') + '\n' : ''
  }
}

/** A single point in a host metric series (mirrors MetricsLedger MetricPoint). */
export interface HostMetricPoint {
  host: string
  at: number
  [metric: string]: number | string | undefined
}

/**
 * Build a PrometheusRegistry from a set of host metric series (the shape the
 * MetricsLedger produces). Each numeric field becomes a per-host gauge.
 */
export function registryFromHostMetrics(
  series: Array<{ host: string; metric: string; value: number }>,
  opts: PrometheusRegistryOptions & { helpPrefix?: string } = {},
): PrometheusRegistry {
  const reg = new PrometheusRegistry(opts)
  const helpPrefix = opts.helpPrefix ?? 'RTerm host metric'
  const byMetric = new Map<string, Array<{ labels: Record<string, string>; value: number }>>()
  for (const s of series) {
    if (!Number.isFinite(s.value)) continue
    let arr = byMetric.get(s.metric)
    if (!arr) byMetric.set(s.metric, (arr = []))
    arr.push({ labels: { host: s.host }, value: s.value })
  }
  for (const [metric, samples] of byMetric) {
    reg.set(metric, `${helpPrefix} ${metric}`, 'gauge', samples)
  }
  return reg
}
