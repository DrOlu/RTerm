import type { StoredChatSession } from '../ChatHistoryService'

/**
 * historySearch — cross-session full-text search over chat history (v3.2.18).
 *
 * The chat panel's built-in search only covers the CURRENT session; this
 * module searches across every stored session so "what did I run on the cisco
 * box last week?" is answerable. Pure + injectable: it operates on the
 * session list the caller provides, so it is fully testable without SQLite.
 *
 * Matching:
 *  - case-insensitive substring on message content (default)
 *  - optional word-boundary mode for exact terms
 *  - optional session-title match (a title hit counts as a session match)
 *
 * Ranking: sessions with more matches rank first; within a session, matches
 * are returned in chronological order. Results are capped to keep responses
 * bounded (default 20 sessions × 3 snippets each).
 */

export interface HistorySearchMatch {
  /** the message id inside the session */
  messageId: string
  /** message type (human/ai/system) */
  type: string
  /** ~120 chars of context around the match */
  snippet: string
  /** character offset of the match within the message content */
  offset: number
}

export interface HistorySearchSessionResult {
  sessionId: string
  sessionTitle: string
  updatedAt: number
  /** total matches in this session */
  matchCount: number
  /** up to snippetLimit snippets */
  matches: HistorySearchMatch[]
}

export interface HistorySearchOptions {
  /** max sessions returned (default 20) */
  sessionLimit?: number
  /** max snippets per session (default 3) */
  snippetLimit?: number
  /** require whole-word matches (default false = substring) */
  wholeWord?: boolean
  /** also match against session titles (default true) */
  includeTitles?: boolean
}

export interface HistorySearchResult {
  query: string
  /** total matching sessions found (before the limit) */
  totalSessions: number
  /** total matches across all sessions (before limits) */
  totalMatches: number
  sessions: HistorySearchSessionResult[]
  truncated: boolean
}

const SNIPPET_CONTEXT = 60
const DEFAULT_SESSION_LIMIT = 20
const DEFAULT_SNIPPET_LIMIT = 3

/** Extract searchable text from a stored message's data payload. */
export function extractMessageText(data: unknown): string {
  if (!data || typeof data !== 'object') return ''
  const obj = data as Record<string, unknown>
  // LangChain messages: content is a string or an array of parts
  const content = obj.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object') {
          const p = part as Record<string, unknown>
          if (typeof p.text === 'string') return p.text
        }
        return ''
      })
      .join(' ')
  }
  return ''
}

/** Build a snippet around a match offset. */
export function buildSnippet(text: string, offset: number, length: number): string {
  const start = Math.max(0, offset - SNIPPET_CONTEXT)
  const end = Math.min(text.length, offset + length + SNIPPET_CONTEXT)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < text.length ? '…' : ''
  return prefix + text.slice(start, end).replace(/\s+/g, ' ').trim() + suffix
}

/** Find all match offsets for a query in a text (case-insensitive). */
export function findMatches(text: string, query: string, wholeWord: boolean): Array<{ offset: number; length: number }> {
  if (!text || !query) return []
  const haystack = text.toLowerCase()
  const needle = query.toLowerCase()
  const out: Array<{ offset: number; length: number }> = []
  if (wholeWord) {
    const re = new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi')
    let m: RegExpExecArray | null
    while ((m = re.exec(haystack)) !== null) {
      out.push({ offset: m.index, length: m[0].length })
      if (m.index === re.lastIndex) re.lastIndex++ // zero-width guard
    }
  } else {
    let idx = haystack.indexOf(needle)
    while (idx !== -1) {
      out.push({ offset: idx, length: needle.length })
      idx = haystack.indexOf(needle, idx + needle.length)
    }
  }
  return out
}

/** Search across all sessions. Pure: no I/O. */
export function searchChatHistory(
  sessions: readonly StoredChatSession[],
  query: string,
  options: HistorySearchOptions = {},
): HistorySearchResult {
  const sessionLimit = options.sessionLimit ?? DEFAULT_SESSION_LIMIT
  const snippetLimit = options.snippetLimit ?? DEFAULT_SNIPPET_LIMIT
  const wholeWord = options.wholeWord ?? false
  const includeTitles = options.includeTitles ?? true

  const trimmed = (query ?? '').trim()
  if (!trimmed) {
    return { query: trimmed, totalSessions: 0, totalMatches: 0, sessions: [], truncated: false }
  }

  const results: HistorySearchSessionResult[] = []
  let totalMatches = 0

  for (const session of sessions) {
    let matchCount = 0
    const matches: HistorySearchMatch[] = []

    // Title match counts toward the session's relevance.
    const titleHit = includeTitles && session.title
      ? findMatches(session.title, trimmed, wholeWord)
      : []

    for (const message of session.messages ?? []) {
      const text = extractMessageText(message.data)
      if (!text) continue
      const hits = findMatches(text, trimmed, wholeWord)
      for (const hit of hits) {
        matchCount++
        totalMatches++
        if (matches.length < snippetLimit) {
          matches.push({
            messageId: message.id,
            type: message.type,
            snippet: buildSnippet(text, hit.offset, hit.length),
            offset: hit.offset,
          })
        }
      }
    }

    if (matchCount === 0 && titleHit.length === 0) continue

    // A title-only hit still surfaces the session (matchCount 0, but relevant).
    results.push({
      sessionId: session.id,
      sessionTitle: session.title,
      updatedAt: session.updatedAt,
      matchCount: matchCount + titleHit.length,
      matches,
    })
  }

  // Most matches first; tie-break by recency.
  results.sort((a, b) => b.matchCount - a.matchCount || b.updatedAt - a.updatedAt)

  const truncated = results.length > sessionLimit
  return {
    query: trimmed,
    totalSessions: results.length,
    totalMatches,
    sessions: results.slice(0, sessionLimit),
    truncated,
  }
}
