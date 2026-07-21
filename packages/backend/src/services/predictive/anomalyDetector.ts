import type { MetricsLedger, MetricPoint } from '../sre/metricsLedger'

/**
 * AnomalyDetector — statistical anomaly detection over the metrics time-series.
 *
 * Flags metric points that deviate from their normal band using:
 *   - z-score            (mean ± k·stddev) — sensitive to outliers in the baseline
 *   - robust z-score     (median ± k·MAD/0.6745) — robust to outliers (recommended)
 * Dependency-free (no ML framework needed) and fully deterministic. Reads from
 * the injected MetricsLedger (v2.0.0).
 */

export type AnomalyMethod = 'zscore' | 'robust'

export interface AnomalyResult {
  host: string
  metric: keyof Omit<MetricPoint, 'host' | 'at'>
  method: AnomalyMethod
  /** the anomalous value. */
  value: number
  /** baseline center (mean or median). */
  center: number
  /** deviation magnitude (|z|). */
  zScore: number
  /** the threshold used. */
  threshold: number
  at: number
  valueAt: number
}

export interface AnomalyOptions {
  method?: AnomalyMethod
  /** |z| above which a point is anomalous (default 3 for zscore, 3.5 for robust). */
  threshold?: number
  /** minimum baseline points required (default 5). */
  minPoints?: number
}

const DEFAULT_MIN_POINTS = 5

function mean(xs: number[]): number { return xs.reduce((a, b) => a + b, 0) / xs.length }
function median(xs: number[]): number {
  const s = xs.slice().sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid]
}
function stddev(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) * (x - m), 0) / xs.length)
}

export class AnomalyDetector {
  constructor(private readonly ledger: MetricsLedger) {}

  /** Detect anomalies in a host's metric over the recent window.
   * The baseline is all points EXCEPT the last `lookbackCount` candidates;
   * the candidates are the most recent points (default: just the latest). */
  detect(host: string, metric: keyof Omit<MetricPoint, 'host' | 'at'>, opts: AnomalyOptions & { lookbackCount?: number } = {}): AnomalyResult[] {
    const method = opts.method ?? 'robust'
    const threshold = opts.threshold ?? (method === 'robust' ? 3.5 : 3)
    const minPoints = opts.minPoints ?? DEFAULT_MIN_POINTS
    const lookbackCount = Math.max(1, opts.lookbackCount ?? 1)

    const series = this.ledger.metricSeries(host, metric)
    const values = series.points.map((p) => p.value)
    if (values.length < minPoints + lookbackCount) return []

    const baseline = values.slice(0, values.length - lookbackCount)
    const candidates = series.points.slice(-lookbackCount)

    const out: AnomalyResult[] = []
    for (const cand of candidates) {
      const value = cand.value
      let center: number
      let z: number
      if (method === 'robust') {
        center = median(baseline)
        const absDev = baseline.map((x) => Math.abs(x - center))
        const mad = median(absDev)
        const sigma = mad === 0 ? 0 : mad / 0.6745
        // Zero variance in the baseline: any deviation from the center is anomalous.
        if (sigma === 0) {
          z = value === center ? 0 : 1e9 // effectively infinite deviation
        } else {
          z = Math.abs(value - center) / sigma
        }
      } else {
        center = mean(baseline)
        const sd = stddev(baseline)
        // Zero stddev: any deviation from the mean is anomalous.
        if (sd === 0) {
          z = value === center ? 0 : 1e9 // effectively infinite deviation
        } else {
          z = Math.abs(value - center) / sd
        }
      }
      if (z > threshold) {
        out.push({ host, metric, method, value, center, zScore: z, threshold, at: Date.now(), valueAt: cand.at })
      }
    }
    return out
  }

  /** Detect anomalies for the latest point of a host (convenience). */
  detectLatest(host: string, metric: keyof Omit<MetricPoint, 'host' | 'at'>, opts: AnomalyOptions = {}): AnomalyResult | undefined {
    return this.detect(host, metric, { ...opts, lookbackCount: 1 })[0]
  }

  /** Detect anomalies across many metrics for a host's latest point. */
  detectLatestAll(host: string, metrics: Array<keyof Omit<MetricPoint, 'host' | 'at'>>, opts: AnomalyOptions = {}): AnomalyResult[] {
    const out: AnomalyResult[] = []
    for (const m of metrics) {
      const r = this.detectLatest(host, m, opts)
      if (r) out.push(r)
    }
    return out
  }
}
