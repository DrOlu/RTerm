import { SpanLedger, newSpanId } from '../apm/spanLedger'

/**
 * llmTrace — OpenLLMetry-style LLM observability for RTerm's agent.
 *
 * Every model invocation (main pass, thinking-model audit, compaction,
 * review) becomes a span in the APM trace store: model name, token usage,
 * latency, finish reason, and error status. Traces are grouped per agent run
 * (traceId = runId) so `observability:apmSummary` / the dashboard APM section
 * show per-run waterfalls and per-model stats without any external collector.
 *
 * Zero dependencies — spans go to RTerm's own SpanLedger. If
 * OTEL_EXPORTER_OTLP_ENDPOINT is set AND an exporter is injected
 * (setOtlpTraceExporter), spans are ALSO forwarded as OTLP/HTTP JSON so
 * Jaeger/Tempo/Datadog can chart LLM calls alongside app traces.
 */

export interface LlmSpanInput {
  /** gateway runId — used as the OTel traceId so one agent run = one trace */
  runId?: string
  sessionId: string
  /** which call site invoked the model (chat | task_guard | self_correction | compaction | review) */
  operation: string
  model: string
  provider?: string
}

export interface LlmSpanResult {
  durationMs: number
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  finishReason?: string
  error?: string
}

const PROVIDER_FROM_MODEL_RE = /^([a-z0-9-]+)\//

function inferProvider(model: string): string {
  const m = PROVIDER_FROM_MODEL_RE.exec(model)
  return m ? m[1] : 'unknown'
}

/** Stable 32-hex traceId from a runId (OTel wants 32 hex chars). */
function traceIdFromRun(runId: string): string {
  // runIds are uuids (36 chars) — normalize to 32 hex by stripping dashes;
  // non-uuid seeds fall back to a repeat of their hex content.
  const stripped = runId.replace(/[^0-9a-fA-F]/g, '')
  if (stripped.length >= 32) return stripped.slice(0, 32)
  if (stripped.length === 0) return '0'.repeat(32)
  let out = stripped
  while (out.length < 32) out += stripped
  return out.slice(0, 32)
}

/** Test-only export of the traceId derivation. */
export const traceIdFromRunForTest = traceIdFromRun

export class LlmTraceRecorder {
  private spanLedger: SpanLedger | null = null
  private otlpForward:
    | ((spans: Array<Record<string, unknown>>) => void)
    | null = null
  private enabled = true

  setSpanLedger(ledger: SpanLedger): void {
    this.spanLedger = ledger
  }

  /** Optional forwarder to an external OTLP endpoint (injected by observability.ts). */
  setOtlpTraceExporter(forward: ((spans: Array<Record<string, unknown>>) => void) | null): void {
    this.otlpForward = forward
  }

  setEnabled(on: boolean): void {
    this.enabled = on
  }

  isEnabled(): boolean {
    return this.enabled && this.spanLedger !== null
  }

  /**
   * Record one completed LLM call. Fire-and-forget safe: never throws.
   */
  record(input: LlmSpanInput, result: LlmSpanResult): void {
    try {
      if (!this.enabled || !this.spanLedger) return
      const now = Date.now()
      const startMs = now - Math.max(0, result.durationMs)
      const traceId = input.runId ? traceIdFromRun(input.runId) : traceIdFromRun(input.sessionId)
      const spanId = newSpanId()
      const isError = Boolean(result.error)

      this.spanLedger.ingest({
        traceId,
        spanId,
        service: `llm.${input.operation}`,
        name: `${input.model} ${input.operation}`,
        startMs,
        durationMs: Math.max(0, result.durationMs),
        status: isError ? 'error' : 'ok',
      })

      if (this.otlpForward) {
        const attributes: Array<{ key: string; value: Record<string, unknown> }> = [
          { key: 'gen_ai.system', value: { stringValue: input.provider || inferProvider(input.model) } },
          { key: 'gen_ai.request.model', value: { stringValue: input.model } },
          { key: 'gen_ai.operation.name', value: { stringValue: input.operation } },
          { key: 'session.id', value: { stringValue: input.sessionId } },
        ]
        if (typeof result.inputTokens === 'number') attributes.push({ key: 'gen_ai.usage.prompt_tokens', value: { intValue: result.inputTokens } })
        if (typeof result.outputTokens === 'number') attributes.push({ key: 'gen_ai.usage.completion_tokens', value: { intValue: result.outputTokens } })
        if (typeof result.totalTokens === 'number') attributes.push({ key: 'gen_ai.usage.total_tokens', value: { intValue: result.totalTokens } })
        if (result.finishReason) attributes.push({ key: 'gen_ai.response.finish_reasons', value: { stringValue: result.finishReason } })
        if (result.error) attributes.push({ key: 'error.message', value: { stringValue: result.error.slice(0, 500) } })

        this.otlpForward([
          {
            traceId,
            spanId,
            parentSpanId: '',
            name: `${input.operation} ${input.model}`,
            startTimeUnixNano: String(BigInt(Math.floor(startMs)) * 1_000_000n),
            endTimeUnixNano: String(BigInt(Math.floor(now)) * 1_000_000n),
            attributes,
            status: { code: isError ? 2 : 1 },
          },
        ])
      }
    } catch {
      // tracing must never break the agent
    }
  }
}
