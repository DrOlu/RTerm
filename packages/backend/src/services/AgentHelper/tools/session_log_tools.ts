import { z } from 'zod'
import type { ToolExecutionContext } from '../types'

/**
 * `list_session_logs` + `read_session_log` — let the agent review recorded
 * terminal sessions (the Netcatty "connection logs" feature). The session
 * logger is wired into the terminal data path when `sessionLogging.enabled`
 * is on; these tools are read-only.
 */

export const listSessionLogsSchema = z.object({})

export const readSessionLogSchema = z.object({
  sessionId: z.string().min(1).describe('The session id (from list_session_logs) to read.'),
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

export async function listSessionLogs(
  args: z.infer<typeof listSessionLogsSchema>,
  context: ToolExecutionContext,
): Promise<string> {
  const logger = context.sessionLogger
  if (!logger) {
    const msg = 'Session logging is not available in this runtime (no session logger wired; enable sessionLogging.enabled in settings).'
    emit(context, 'list_session_logs', args, msg)
    return msg
  }
  const list = logger.list()
  if (!list.length) {
    const msg = 'No recorded sessions yet. Sessions are recorded when sessionLogging is enabled and you open a terminal tab.'
    emit(context, 'list_session_logs', args, msg)
    return msg
  }
  const body = list
    .map((l) => `- ${l.title} (sessionId=${l.sessionId}, type=${l.type}, started=${l.startedAt}${l.endedAt ? `, ended=${l.endedAt}` : ''}, ${l.bytes} bytes)`)
    .join('\n')
  const msg = `Recorded sessions (${list.length}):\n${body}`
  emit(context, 'list_session_logs', args, msg)
  return msg
}

export async function readSessionLog(
  args: z.infer<typeof readSessionLogSchema>,
  context: ToolExecutionContext,
): Promise<string> {
  const logger = context.sessionLogger
  if (!logger) {
    const msg = 'Session logging is not available in this runtime (no session logger wired; enable sessionLogging.enabled in settings).'
    emit(context, 'read_session_log', args, msg)
    return msg
  }
  const content = logger.read(args.sessionId)
  if (!content) {
    const msg = `No recorded log for sessionId="${args.sessionId}". Use list_session_logs to see valid ids.`
    emit(context, 'read_session_log', args, msg)
    return msg
  }
  const truncated = content.length > 8000 ? `${content.slice(0, 4000)}\n…[truncated ${content.length - 8000} chars]…\n${content.slice(-4000)}` : content
  const msg = `Session log for "${args.sessionId}" (${content.length} bytes):\n<session_log>\n${truncated}\n</session_log>`
  emit(context, 'read_session_log', args, msg)
  return msg
}
