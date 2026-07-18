import { z } from 'zod'
import type { ToolExecutionContext } from '../types'

/**
 * `get_run_ledger` — query the persisted agent run audit + token-cost ledger.
 * Every agent run is recorded (start/finish, status, error, per-call token
 * usage) in a local SQLite ledger so operators can answer "what did the agent
 * do and what did it cost?" after the fact. Read-only tool.
 */

export const getRunLedgerSchema = z.object({
  action: z.enum(['list', 'summary', 'get']).describe("'list' recent runs, 'summary' of token usage by model, or 'get' one run with its usage events."),
  runId: z.string().optional().describe("Required for action='get' — the run id from a list result."),
  sessionId: z.string().optional().describe("Optional: restrict 'list' to runs of one chat session."),
  status: z.enum(['running', 'completed', 'failed', 'aborted']).optional().describe("Optional: restrict 'list' to one status."),
  limit: z.number().int().min(1).max(200).optional().describe("Max runs for 'list' (default 20)."),
  sinceDays: z.number().min(0).max(365).optional().describe("Optional: 'summary' only counts runs started within the last N days (default: all time)."),
})

function emit(context: ToolExecutionContext, toolName: string, input: unknown, output: string): void {
  context.sendEvent(context.sessionId, {
    messageId: context.messageId,
    type: 'tool_call',
    toolName,
    input: typeof input === 'string' ? input : JSON.stringify(input),
    output,
  })
}

function fmtRun(r: {
  runId: string; sessionId: string; status: string; startedAt: number; endedAt?: number
  model?: string; promptTokens: number; completionTokens: number; usageEvents: number
  inputPreview?: string; error?: string
}): string {
  const durMs = r.endedAt ? r.endedAt - r.startedAt : 0
  const dur = r.endedAt ? `, ${(durMs / 1000).toFixed(1)}s` : ''
  const model = r.model ? `, model=${r.model}` : ''
  const tokens = `, tokens=${r.promptTokens}in/${r.completionTokens}out over ${r.usageEvents} call(s)`
  const input = r.inputPreview ? `\n    input: ${r.inputPreview.slice(0, 160)}` : ''
  const err = r.error ? `\n    error: ${r.error}` : ''
  return `- ${r.runId} [${r.status}] started=${new Date(r.startedAt).toISOString()}${dur}${model}${tokens}${input}${err}`
}

export async function getRunLedger(
  args: z.infer<typeof getRunLedgerSchema>,
  context: ToolExecutionContext,
): Promise<string> {
  const ledger = context.agentRunLedger
  if (!ledger) {
    const msg = 'Run ledger is not available in this runtime (no agent run ledger wired).'
    emit(context, 'get_run_ledger', args, msg)
    return msg
  }

  if (args.action === 'list') {
    const runs = ledger.listRuns({ limit: args.limit ?? 20, sessionId: args.sessionId, status: args.status })
    if (!runs.length) {
      const msg = 'No agent runs recorded yet in the ledger.'
      emit(context, 'get_run_ledger', args, msg)
      return msg
    }
    const msg = `Agent run ledger — ${runs.length} most recent run(s):\n${runs.map(fmtRun).join('\n')}`
    emit(context, 'get_run_ledger', args, msg)
    return msg
  }

  if (args.action === 'summary') {
    const sinceMs = typeof args.sinceDays === 'number' ? Date.now() - args.sinceDays * 24 * 3600 * 1000 : undefined
    const s = ledger.summarize({ sinceMs })
    const scope = typeof args.sinceDays === 'number' ? `last ${args.sinceDays} day(s)` : 'all time'
    const models = s.byModel.length
      ? s.byModel.map((m) => `  - ${m.model}: ${m.runs} run(s), ${m.promptTokens} in / ${m.completionTokens} out`).join('\n')
      : '  (no usage recorded)'
    const msg = [
      `Agent run summary (${scope}):`,
      `  runs: ${s.totalRuns} total — ${s.completedRuns} completed, ${s.failedRuns} failed, ${s.abortedRuns} aborted`,
      `  tokens: ${s.promptTokens} prompt in / ${s.completionTokens} completion out`,
      `  by model:`,
      models,
    ].join('\n')
    emit(context, 'get_run_ledger', args, msg)
    return msg
  }

  // action === 'get'
  if (!args.runId) {
    const msg = "runId is required for action='get'. Use action='list' to find run ids."
    emit(context, 'get_run_ledger', args, msg)
    return msg
  }
  const got = ledger.getRun(args.runId)
  if (!got) {
    const msg = `No run with id "${args.runId}" in the ledger.`
    emit(context, 'get_run_ledger', args, msg)
    return msg
  }
  const usage = got.usage.length
    ? got.usage
        .map((u) => `  - ${new Date(u.at).toISOString()} model=${u.model ?? '?'} ${u.promptTokens} in / ${u.completionTokens} out${u.totalTokens ? ` (context=${u.totalTokens})` : ''}`)
        .join('\n')
    : '  (no usage events)'
  const msg = `Run ${got.run.runId}:\n${fmtRun(got.run)}\n  usage events:\n${usage}`
  emit(context, 'get_run_ledger', args, msg)
  return msg
}
