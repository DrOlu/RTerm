import { buildOtlpMetricsPayload, OtelExporter } from './sre/otelExporter'
import { registryFromHostMetrics } from './sre/prometheusExporter'
import { LlmTraceRecorder, traceIdFromRunForTest } from './observability/llmTrace'
import { SpanLedger } from './apm/spanLedger'

/**
 * v3213OtelFixes.extreme.spec — v3.2.13 observability fixes:
 *   1. OTel pusher now pushes the freshly-built host-metrics registry
 *      (was pushing an empty boot-time singleton).
 *   2. OpenLLMetry-style LLM tracing: model calls become spans in the APM
 *      ledger with gen_ai attributes and optional OTLP forwarding.
 */

const tests: Array<{ name: string; run: () => void | Promise<void> }> = []
function test(name: string, run: () => void | Promise<void>) { tests.push({ name, run }) }
function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message}. expected=${String(expected)} actual=${String(actual)}`)
}
function assertTrue(actual: boolean, message: string): void {
  if (actual !== true) throw new Error(`${message}. expected=true actual=${String(actual)}`)
}

// ─── 1. OTel pusher wiring fix ──────────────────────────────────────────────

test('host-metrics registry built from ledger data is non-empty', () => {
  const reg = registryFromHostMetrics(
    [
      { host: 'web-1', metric: 'host_cpu_usagePercent', value: 42.5 },
      { host: 'web-2', metric: 'host_cpu_usagePercent', value: 71 },
    ],
    { prefix: 'rterm' },
  )
  assertTrue(reg.size() > 0, 'registry must contain metric families')
  const text = reg.render()
  assertTrue(text.includes('rterm_host_cpu_usagePercent'), 'rendered text has the metric')
})

test('OTLP payload from a populated registry contains the metrics + labels', () => {
  const reg = registryFromHostMetrics(
    [{ host: 'db-1', metric: 'host_mem_usedPercent', value: 88 }],
    { prefix: 'rterm' },
  )
  const payload = buildOtlpMetricsPayload(reg, { 'service.name': 'rterm' }, Date.now())
  const rm = payload.resourceMetrics[0]
  const metrics = rm.scopeMetrics[0].metrics
  assertEqual(metrics.length, 1, 'one metric family')
  assertEqual(metrics[0].name, 'rterm_host_mem_usedPercent', 'metric name prefixed')
  const dp = metrics[0].gauge?.dataPoints?.[0]
  assertEqual(dp?.asDouble, 88, 'gauge value carried')
  const hostLabel = dp?.attributes?.find((a) => a.key === 'host')
  assertEqual(hostLabel?.value.stringValue, 'db-1', 'host label carried')
})

/** Mirrors the v3.2.13 pushOnce fix: push the rebuilt registry, not a stale one. */
test('pusher sends non-empty payload when given the freshly-built registry', async () => {
  let sentBody: unknown = null
  const exporter = new OtelExporter({
    endpoint: 'http://collector.test/v1/metrics',
    send: async (_endpoint, body) => {
      sentBody = body
      return { ok: true, status: 200 }
    },
  })
  // Simulate what observability.ts now does each interval:
  const freshRegistry = registryFromHostMetrics(
    [{ host: 'h1', metric: 'host_load_1m', value: 1.7 }],
    { prefix: 'rterm' },
  )
  await exporter.push(freshRegistry)
  const metrics = (sentBody as any)?.resourceMetrics?.[0]?.scopeMetrics?.[0]?.metrics ?? []
  assertTrue(metrics.length > 0, 'pushed payload must contain metrics')
  assertEqual(metrics[0].name, 'rterm_host_load_1m', 'pushed metric is the host metric')
})

// ─── 2. LLM trace recorder ─────────────────────────────────────────────────

function makeLedgerSpy(): { ledger: SpanLedger; spans: any[] } {
  const ledger = new SpanLedger({})
  const origIngest = ledger.ingest.bind(ledger)
  const spans: any[] = []
  ;(ledger as any).ingest = (span: any) => {
    spans.push(span)
    return origIngest(span)
  }
  return { ledger, spans }
}

test('llmTrace: successful chat call becomes an ok span in the ledger', () => {
  const { ledger, spans } = makeLedgerSpy()
  const rec = new LlmTraceRecorder()
  rec.setSpanLedger(ledger)
  rec.record(
    { runId: 'd1d1d1d1-1111-4111-8111-111111111111', sessionId: 's1', operation: 'chat', model: 'moonshotai/kimi-k3' },
    { durationMs: 1234, inputTokens: 100, outputTokens: 20, totalTokens: 120 },
  )
  assertEqual(spans.length, 1, 'exactly one span ingested')
  assertEqual(spans[0].service, 'llm.chat', 'service is llm.<operation>')
  assertEqual(spans[0].status, 'ok', 'status ok')
  assertEqual(spans[0].durationMs, 1234, 'duration recorded')
  assertEqual(ledger.size(), 1, 'ledger holds the span')
})

test('llmTrace: failed call becomes an error span with error forwarded', () => {
  const { ledger, spans } = makeLedgerSpy()
  const rec = new LlmTraceRecorder()
  rec.setSpanLedger(ledger)
  rec.record(
    { sessionId: 's2', operation: 'audit.task_completion_guard', model: 'gpt-x' },
    { durationMs: 50, error: 'rate limited' },
  )
  assertEqual(spans[0].status, 'error', 'error status')
  assertEqual(spans[0].service, 'llm.audit.task_completion_guard', 'audit operation in service name')
})

test('llmTrace: spans of one run share a stable traceId', () => {
  const { ledger, spans } = makeLedgerSpy()
  const rec = new LlmTraceRecorder()
  rec.setSpanLedger(ledger)
  const runId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  rec.record({ runId, sessionId: 's', operation: 'chat', model: 'm' }, { durationMs: 10 })
  rec.record({ runId, sessionId: 's', operation: 'thinking', model: 'm' }, { durationMs: 10 })
  rec.record({ runId, sessionId: 's', operation: 'chat', model: 'm' }, { durationMs: 10 })
  const ids = new Set(spans.map((s) => s.traceId))
  assertEqual(ids.size, 1, 'all spans of one run share one traceId')
  assertEqual(spans[0].traceId.length, 32, 'traceId is 32 hex chars (OTel)')
  assertEqual(ledger.summarize(spans[0].traceId)?.spanCount, 3, 'trace summarizes 3 spans')
})

test('llmTrace: OTLP forward receives gen_ai attributes', () => {
  const rec = new LlmTraceRecorder()
  const ledger = new SpanLedger({})
  rec.setSpanLedger(ledger)
  let forwarded: any[] | null = null
  rec.setOtlpTraceExporter((spans) => { forwarded = spans })
  rec.record(
    { runId: '11112222-3333-4444-5555-666677778888', sessionId: 'sess-9', operation: 'chat', model: 'openai/gpt-4o' },
    { durationMs: 500, inputTokens: 10, outputTokens: 5, totalTokens: 15, finishReason: 'stop' },
  )
  assertTrue(Array.isArray(forwarded), 'forwarder called')
  const span = (forwarded as unknown as any[])[0]
  const attr = (key: string) => span.attributes.find((a: any) => a.key === key)?.value
  assertEqual(attr('gen_ai.system').stringValue, 'openai', 'provider inferred from model id')
  assertEqual(attr('gen_ai.request.model').stringValue, 'openai/gpt-4o', 'model attribute')
  assertEqual(attr('gen_ai.usage.prompt_tokens').intValue, 10, 'prompt tokens')
  assertEqual(attr('gen_ai.usage.completion_tokens').intValue, 5, 'completion tokens')
  assertEqual(span.status.code, 1, 'ok status code (OTel)')
  assertTrue(String(span.startTimeUnixNano).length >= 16, 'ns timestamps')
})

test('llmTrace: disabled recorder records nothing', () => {
  const { ledger, spans } = makeLedgerSpy()
  const rec = new LlmTraceRecorder()
  rec.setSpanLedger(ledger)
  rec.setEnabled(false)
  rec.record({ sessionId: 's', operation: 'chat', model: 'm' }, { durationMs: 5 })
  assertEqual(spans.length, 0, 'no span when disabled')
})

test('llmTrace: never throws even with no ledger set', () => {
  const rec = new LlmTraceRecorder()
  rec.record({ sessionId: 's', operation: 'chat', model: 'm' }, { durationMs: 5 })
  assertTrue(true, 'did not throw')
})

test('traceIdFromRunForTest: uuid → 32 hex chars deterministically', () => {
  const a = traceIdFromRunForTest('d36ef9f7-68b3-45de-83cf-ac2e86793f95')
  const b = traceIdFromRunForTest('d36ef9f7-68b3-45de-83cf-ac2e86793f95')
  assertEqual(a, b, 'same input → same traceId')
  assertEqual(a.length, 32, '32 chars')
  assertTrue(/^[0-9a-f]{32}$/.test(a), 'hex only')
})

// ─── Runner ────────────────────────────────────────────────────────────────

async function main() {
  let pass = 0, fail = 0
  for (const t of tests) {
    try { await t.run(); pass++; console.log(`PASS ${t.name}`) }
    catch (e) { fail++; console.log(`FAIL ${t.name}: ${(e as Error).message}`) }
  }
  console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}
void main()
