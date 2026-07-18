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

export const searchSessionLogsSchema = z.object({
  query: z.string().min(1).describe('The text (or regex) to search for across recorded session logs.'),
  sessionId: z.string().optional().describe('Optional: restrict the search to a single sessionId.'),
  host: z.string().optional().describe('Optional: restrict to sessions whose title/host contains this substring.'),
  since: z.string().optional().describe('Optional ISO date — only sessions started at/after this time.'),
  until: z.string().optional().describe('Optional ISO date — only sessions started at/before this time.'),
  regex: z.boolean().optional().describe('Treat query as a regular expression (default false = literal substring).'),
  caseSensitive: z.boolean().optional().describe('Case-sensitive matching (default false).'),
  maxMatches: z.number().int().min(1).max(500).optional().describe('Max matching lines to return (default 50).'),
  contextLines: z.number().int().min(0).max(20).optional().describe('Lines of surrounding context per match (default 0).'),
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

export async function searchSessionLogs(
  args: z.infer<typeof searchSessionLogsSchema>,
  context: ToolExecutionContext,
): Promise<string> {
  const logger = context.sessionLogger
  if (!logger || typeof logger.search !== 'function') {
    const msg = 'Session logging is not available in this runtime (no session logger wired; enable sessionLogging.enabled in settings).'
    emit(context, 'search_session_logs', args, msg)
    return msg
  }
  const result = logger.search(args.query, {
    sessionId: args.sessionId,
    host: args.host,
    since: args.since,
    until: args.until,
    regex: args.regex,
    caseSensitive: args.caseSensitive,
    maxMatches: args.maxMatches,
    contextLines: args.contextLines,
  })
  if (result.totalMatches === 0) {
    const msg = `No matches for "${args.query}" across ${result.sessionsSearched} recorded session(s).`
    emit(context, 'search_session_logs', args, msg)
    return msg
  }
  const lines = result.matches.map((m) => {
    const ctx = [
      ...m.contextBefore.map((c: string) => `    ${c}`),
      `  > ${m.text}`,
      ...m.contextAfter.map((c: string) => `    ${c}`),
    ].join('\n')
    return `- [${m.title} · ${m.sessionId} · ${m.startedAt} · line ${m.line}]\n${ctx}`
  })
  const msg = `Found ${result.totalMatches} match(es) for "${args.query}" across ${result.sessionsSearched} session(s):\n${lines.join('\n')}`
  emit(context, 'search_session_logs', args, msg)
  return msg
}
