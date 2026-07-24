/**
 * otelExporter — push metrics (and span summaries) OUT to an OpenTelemetry
 * collector over OTLP/HTTP JSON (Tier 1). Complements the Prometheus scrape
 * exporter for shops that run a push-based collector (OTel, Datadog Agent,
 * Grafana Agent) instead of Prometheus.
 *
 * Pure + injectable: builds the OTLP payload from registered metrics; the
 * actual HTTP POST is injected so tests never touch the network.
 */

import type { PrometheusRegistry } from './prometheusExporter'

export interface OtlpKeyValue {
  key: string
  value: { stringValue?: string; intValue?: number; doubleValue?: number; boolValue?: boolean }
}

export interface OtlpNumberDataPoint {
  attributes?: OtlpKeyValue[]
  timeUnixNano: string
  asDouble?: number
  asInt?: number
}

export interface OtlpMetric {
  name: string
  description?: string
  unit?: string
  gauge?: { dataPoints: OtlpNumberDataPoint[] }
  sum?: { dataPoints: OtlpNumberDataPoint[]; aggregationTemporality: number; isMonotonic: boolean }
}

export interface OtlpMetricsPayload {
  resourceMetrics: Array<{
    resource: { attributes: OtlpKeyValue[] }
    scopeMetrics: Array<{ scope: { name: string }; metrics: OtlpMetric[] }>
  }>
}

export interface OtelExporterOptions {
  /** OTLP/HTTP endpoint (e.g. http://collector:4318/v1/metrics). */
  endpoint: string
  /** resource attributes (service.name, host.name, etc.). */
  resourceAttributes?: Record<string, string>
  /** extra headers (auth, tenant). */
  headers?: Record<string, string>
  /** injected clock (default Date.now). */
  now?: () => number
  /** injected sender (POST JSON, return status). Default: real fetch. */
  send?: (endpoint: string, body: unknown, headers: Record<string, string>) => Promise<{ ok: boolean; status: number }>
}

function kv(key: string, value: string | number | boolean): OtlpKeyValue {
  if (typeof value === 'number') return { key, value: { doubleValue: value } }
  if (typeof value === 'boolean') return { key, value: { boolValue: value } }
  return { key, value: { stringValue: value } }
}

function attrs(labels: Record<string, string> | undefined): OtlpKeyValue[] | undefined {
  if (!labels) return undefined
  const out = Object.keys(labels).sort().map((k) => kv(k, labels[k]))
  return out.length > 0 ? out : undefined
}

/** Default sender — real OTLP/HTTP POST (injected in tests). */
async function defaultSend(
  endpoint: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<{ ok: boolean; status: number }> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  return { ok: res.ok, status: res.status }
}

/** Build the OTLP metrics payload from a Prometheus registry (pure). */
export function buildOtlpMetricsPayload(
  registry: PrometheusRegistry,
  resourceAttributes: Record<string, string>,
  nowMs: number,
): OtlpMetricsPayload {
  const nano = String(BigInt(Math.floor(nowMs)) * 1_000_000n)
  const metrics: OtlpMetric[] = []
  for (const m of registry.list()) {
    const dataPoints: OtlpNumberDataPoint[] = m.samples
      .filter((s) => Number.isFinite(s.value))
      .map((s) => ({
        attributes: attrs(s.labels),
        timeUnixNano: nano,
        asDouble: s.value,
      }))
    if (dataPoints.length === 0) continue
    if (m.type === 'gauge') {
      metrics.push({ name: m.name, description: m.help, gauge: { dataPoints } })
    } else {
      // counter → OTLP sum (cumulative, monotonic)
      metrics.push({
        name: m.name,
        description: m.help,
        sum: { dataPoints, aggregationTemporality: 2 /* CUMULATIVE */, isMonotonic: true },
      })
    }
  }
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: Object.keys(resourceAttributes)
            .sort()
            .map((k) => kv(k, resourceAttributes[k])),
        },
        scopeMetrics: [{ scope: { name: 'rterm' }, metrics }],
      },
    ],
  }
}

/** Pushes metrics to an OTLP collector on demand. */
export class OtelExporter {
  private readonly endpoint: string
  private readonly resourceAttributes: Record<string, string>
  private readonly headers: Record<string, string>
  private readonly now: () => number
  private readonly send: NonNullable<OtelExporterOptions['send']>
  private lastResult: { ok: boolean; status: number; at: number } | null = null

  constructor(opts: OtelExporterOptions) {
    if (!opts.endpoint || typeof opts.endpoint !== 'string') throw new Error('otel exporter needs an endpoint')
    this.endpoint = opts.endpoint
    this.resourceAttributes = { 'service.name': 'rterm', ...opts.resourceAttributes }
    this.headers = opts.headers ?? {}
    this.now = opts.now ?? Date.now
    this.send = opts.send ?? defaultSend
  }

  /** Push the registry's metrics to the collector. Returns the result. */
  async push(registry: PrometheusRegistry): Promise<{ ok: boolean; status: number }> {
    const payload = buildOtlpMetricsPayload(registry, this.resourceAttributes, this.now())
    const res = await this.send(this.endpoint, payload, this.headers)
    this.lastResult = { ...res, at: this.now() }
    return res
  }

  /** Last push result (ok/status/at), or null if never pushed. */
  last(): { ok: boolean; status: number; at: number } | null {
    return this.lastResult
  }
}
