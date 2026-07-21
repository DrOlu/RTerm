import { createHash, randomUUID } from 'crypto'

/**
 * SpanLedger — APM Tier: store and analyze distributed-trace spans (the APM
 * *consumer* tier). Apps export OpenTelemetry spans (OTLP); this ledger stores
 * them and answers code-level questions: slow traces, error rates per service,
 * duration percentiles, and bottleneck services.
 *
 * Pure + injectable: spans are fed via `ingest` (from an OTLP receiver or a
 * collector); analysis is pure. Storage is injected (in-memory default; a
 * SQLite store wraps it). Deterministic `now` for tests.
 */

export interface Span {
  traceId: string
  spanId: string
  parentSpanId?: string
  service: string
  name: string
  /** start time (ms since epoch). */
  startMs: number
  /** duration (ms). */
  durationMs: number
  status?: 'ok' | 'error'
  attributes?: Record<string, string | number | boolean>
}

export interface TraceSummary {
  traceId: string
  rootService: string
  spanCount: number
  totalDurationMs: number
  hasError: boolean
  services: string[]
  at: number
}

export interface ServiceStats {
  service: string
  spanCount: number
  errorCount: number
  errorRate: number
  p50Ms?: number
  p95Ms?: number
  p99Ms?: number
  maxMs?: number
}

export interface SpanLedgerOptions {
  now?: () => number
  /** max spans retained (ring buffer; default 50_000). */
  spanLimit?: number
}

const DEFAULT_LIMIT = 50_000

function percentile(sorted: number[], p: number): number | undefined {
  if (sorted.length === 0) return undefined
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}

export class SpanLedger {
  private readonly spans = new Map<string, Span[]>() // traceId -> spans
  private readonly order: string[] = [] // traceIds in insert order
  private readonly spanLimit: number
  private totalSpans = 0

  constructor(opts: SpanLedgerOptions = {}) {
    this.spanLimit = opts.spanLimit ?? DEFAULT_LIMIT
  }

  /** Ingest one span. */
  ingest(span: Span): void {
    let arr = this.spans.get(span.traceId)
    if (!arr) {
      arr = []
      this.spans.set(span.traceId, arr)
      this.order.push(span.traceId)
    }
    arr.push(span)
    this.totalSpans += 1
    // ring buffer: drop oldest traces when over the limit
    while (this.totalSpans > this.spanLimit && this.order.length > 0) {
      const oldest = this.order.shift()!
      const old = this.spans.get(oldest) ?? []
      this.totalSpans -= old.length
      this.spans.delete(oldest)
    }
  }

  /** Ingest many spans. */
  ingestBatch(spans: Span[]): number {
    for (const s of spans) this.ingest(s)
    return spans.length
  }

  /** All spans for a trace. */
  trace(traceId: string): readonly Span[] {
    return this.spans.get(traceId) ?? []
  }

  traceIds(): readonly string[] {
    return this.order
  }

  /** Summarize a trace (root service, span count, total duration, error). */
  summarize(traceId: string): TraceSummary | undefined {
    const spans = this.spans.get(traceId)
    if (!spans || spans.length === 0) return undefined
    const root = spans.find((s) => !s.parentSpanId) ?? spans[0]
    const services = Array.from(new Set(spans.map((s) => s.service)))
    const hasError = spans.some((s) => s.status === 'error')
    const start = Math.min(...spans.map((s) => s.startMs))
    const end = Math.max(...spans.map((s) => s.startMs + s.durationMs))
    return {
      traceId,
      rootService: root.service,
      spanCount: spans.length,
      totalDurationMs: end - start,
      hasError,
      services,
      at: start,
    }
  }

  /** Per-service stats over a window. */
  serviceStats(opts: { sinceMs?: number; service?: string } = {}): ServiceStats[] {
    const byService = new Map<string, { durations: number[]; errors: number }>()
    for (const arr of this.spans.values()) {
      for (const s of arr) {
        if (opts.sinceMs !== undefined && s.startMs < opts.sinceMs) continue
        if (opts.service && s.service !== opts.service) continue
        let e = byService.get(s.service)
        if (!e) { e = { durations: [], errors: 0 }; byService.set(s.service, e) }
        e.durations.push(s.durationMs)
        if (s.status === 'error') e.errors += 1
      }
    }
    const out: ServiceStats[] = []
    for (const [service, e] of byService) {
      const durations = e.durations.slice().sort((a, b) => a - b)
      out.push({
        service,
        spanCount: durations.length,
        errorCount: e.errors,
        errorRate: durations.length > 0 ? e.errors / durations.length : 0,
        p50Ms: percentile(durations, 50),
        p95Ms: percentile(durations, 95),
        p99Ms: percentile(durations, 99),
        maxMs: durations.length > 0 ? durations[durations.length - 1] : undefined,
      })
    }
    return out.sort((a, b) => (b.p95Ms ?? 0) - (a.p95Ms ?? 0))
  }

  /** Slowest traces by total duration. */
  slowestTraces(limit = 10, opts: { sinceMs?: number } = {}): TraceSummary[] {
    const summaries: TraceSummary[] = []
    for (const id of this.order) {
      const s = this.summarize(id)
      if (!s) continue
      if (opts.sinceMs !== undefined && s.at < opts.sinceMs) continue
      summaries.push(s)
    }
    return summaries.sort((a, b) => b.totalDurationMs - a.totalDurationMs).slice(0, limit)
  }

  /** Services ranked by total error count (bottleneck/failing services). */
  bottleneckServices(opts: { sinceMs?: number } = {}): ServiceStats[] {
    return this.serviceStats(opts).sort((a, b) => b.errorCount - a.errorCount)
  }

  /** Total stored spans. */
  size(): number {
    return this.totalSpans
  }

  clear(): void {
    this.spans.clear()
    this.order.length = 0
    this.totalSpans = 0
  }
}

/** Parse an OTLP/HTTP JSON ExportTraceServiceRequest into Span[] (the OTLP
 * consumer entry point). Tolerant of the standard OTLP JSON shape. */
export function parseOtlpJson(payload: unknown, defaultService = 'unknown'): Span[] {
  const out: Span[] = []
  const root = payload as { resourceSpans?: unknown[] }
  const rs = root?.resourceSpans
  if (!Array.isArray(rs)) return out
  for (const r of rs) {
    const rr = r as { resource?: { attributes?: Array<{ key: string; value?: { stringValue?: string } }> }; scopeSpans?: unknown[] }
    let service = defaultService
    const attrs = rr?.resource?.attributes ?? []
    const svc = attrs.find((a) => a.key === 'service.name')?.value?.stringValue
    if (svc) service = svc
    const scopeSpans = rr?.scopeSpans
    if (!Array.isArray(scopeSpans)) continue
    for (const ss of scopeSpans) {
      const spans = (ss as { spans?: unknown[] })?.spans
      if (!Array.isArray(spans)) continue
      for (const sp of spans) {
        const s = sp as {
          traceId?: string; spanId?: string; parentSpanId?: string; name?: string;
          startTimeUnixNano?: string | number; endTimeUnixNano?: string | number;
          status?: { code?: number | string };
        }
        if (!s.traceId || !s.spanId) continue
        const startNs = Number(s.startTimeUnixNano ?? 0)
        const endNs = Number(s.endTimeUnixNano ?? 0)
        const startMs = startNs / 1e6
        const durationMs = Math.max(0, (endNs - startNs) / 1e6)
        const isErr = s.status?.code === 2 || s.status?.code === 'STATUS_CODE_ERROR' || s.status?.code === 'Error'
        out.push({
          traceId: String(s.traceId),
          spanId: String(s.spanId),
          ...(s.parentSpanId ? { parentSpanId: String(s.parentSpanId) } : {}),
          service,
          name: s.name ?? 'span',
          startMs,
          durationMs,
          status: isErr ? 'error' : 'ok',
        })
      }
    }
  }
  return out
}

/** A minimal OTLP/HTTP ingest handler: parse + ingest into the ledger. Returns
 * the count of spans ingested. */
export function ingestOtlp(ledger: SpanLedger, payload: unknown, defaultService = 'unknown'): number {
  const spans = parseOtlpJson(payload, defaultService)
  return ledger.ingestBatch(spans)
}

/** Compute a stable id when a source has none. */
export function stableId(seed: string): string {
  return createHash('sha1').update(seed).digest('hex').slice(0, 16)
}

export function newSpanId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 16)
}
