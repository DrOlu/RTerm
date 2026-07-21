import type { MetricsLedger, MetricPoint } from '../sre/metricsLedger'
import type { AnomalyDetector } from './anomalyDetector'

/**
 * EarlyWarningService — predictive failure alerting.
 *
 * Combines trend forecasting (days-to-threshold from the MetricsLedger) with
 * statistical anomaly detection to raise *predictive* warnings BEFORE a breach:
 *   - "disk will hit 95% in N days" (forecast)
 *   - "cpu just spiked 4σ above normal" (anomaly)
 * Emits EarlyWarning records (via an injected alert/incident callback) and can
 * propose a MOP change for predictive auto-remediation.
 */

export type WarningKind = 'forecast' | 'anomaly'

export interface EarlyWarning {
  kind: WarningKind
  host: string
  metric: string
  /** forecast: days until the threshold. anomaly: z-score. */
  value: number
  /** forecast: the threshold. anomaly: baseline center. */
  reference: number
  message: string
  at: number
}

export interface EarlyWarningOptions {
  /** forecast: the metric threshold to watch (e.g. 95 for disk). */
  threshold: number
  /** forecast: warn when days-to-threshold <= this (default 7). */
  warnDays?: number
  /** anomaly: also flag anomalies. */
  includeAnomalies?: boolean
  now?: () => number
}

export interface EarlyWarningDeps {
  ledger: MetricsLedger
  anomalyDetector: AnomalyDetector
  /** called for each predictive warning (raise alert/incident). */
  onWarning?: (warning: EarlyWarning) => void
  /** optional MOP change proposer for predictive auto-remediation. */
  proposeChange?: (warning: EarlyWarning) => Promise<string>
  now?: () => number
}

export class EarlyWarningService {
  private readonly now: () => number

  constructor(private readonly deps: EarlyWarningDeps) {
    this.now = deps.now ?? (() => Date.now())
  }

  /** Evaluate a host+metric for a predictive breach (forecast and/or anomaly). */
  evaluate(host: string, metric: keyof Omit<MetricPoint, 'host' | 'at'>, opts: EarlyWarningOptions): EarlyWarning[] {
    const warnings: EarlyWarning[] = []
    const warnDays = opts.warnDays ?? 7

    // Forecast: days until the metric crosses the threshold.
    const days = this.deps.ledger.daysUntilThreshold(host, metric, opts.threshold)
    if (days !== undefined && days <= warnDays) {
      const msg = days <= 0
        ? `${host} ${metric} has already crossed ${opts.threshold}`
        : `${host} ${metric} is forecast to hit ${opts.threshold} in ~${Math.ceil(days)} day${Math.ceil(days) === 1 ? '' : 's'}`
      warnings.push({
        kind: 'forecast', host, metric: String(metric), value: days, reference: opts.threshold,
        message: msg, at: this.now(),
      })
    }

    // Anomaly: latest point deviates from the baseline.
    if (opts.includeAnomalies !== false) {
      const anomaly = this.deps.anomalyDetector.detectLatest(host, metric)
      if (anomaly) {
        warnings.push({
          kind: 'anomaly', host, metric: String(metric), value: anomaly.zScore, reference: anomaly.center,
          message: `${host} ${metric} anomaly: ${anomaly.value.toFixed(1)} is ${anomaly.zScore.toFixed(1)}σ from baseline ${anomaly.center.toFixed(1)}`,
          at: this.now(),
        })
      }
    }

    for (const w of warnings) {
      try { this.deps.onWarning?.(w) } catch { /* best-effort */ }
      if (this.deps.proposeChange) {
        void this.deps.proposeChange(w).catch(() => {})
      }
    }
    return warnings
  }

  /** Evaluate a host across many metrics. */
  evaluateHost(host: string, metrics: Array<keyof Omit<MetricPoint, 'host' | 'at'>>, opts: EarlyWarningOptions): EarlyWarning[] {
    const out: EarlyWarning[] = []
    for (const m of metrics) out.push(...this.evaluate(host, m, opts))
    return out
  }

  /** Evaluate every host in the ledger across the given metrics. */
  evaluateAll(metrics: Array<keyof Omit<MetricPoint, 'host' | 'at'>>, opts: EarlyWarningOptions): EarlyWarning[] {
    const out: EarlyWarning[] = []
    for (const host of this.deps.ledger.hosts()) {
      out.push(...this.evaluateHost(host, metrics, opts))
    }
    return out
  }
}
