/**
 * memoryManager — structured operations over the freeform `memory.md` file:
 * search, dedupe, append-with-cap, and a relevance-ranked recall block for the
 * system prompt. Pure + injectable (file I/O injected). Deterministic for tests.
 *
 * Why: memory.md grows forever and the WHOLE file is injected into every system
 * prompt (prompts.ts buildMemoryPromptBlock) — so it balloons context and dilutes
 * relevance. This adds: (1) a search tool, (2) append-with-dedupe + size cap,
 * (3) recallForPrompt() that injects only the most relevant entries instead of
 * the whole file.
 */

export interface MemoryEntry {
  /** the raw text of the entry (one bullet/line/block). */
  text: string
  /** lowercased tokens extracted for matching. */
  tokens: string[]
}

/** Split memory markdown into searchable entries (bullets + headings + paragraphs). */
export function parseMemoryEntries(content: string): MemoryEntry[] {
  const out: MemoryEntry[] = []
  const lines = String(content || '').replace(/\r\n/g, '\n').split('\n')
  for (const line of lines) {
    const t = line.trim()
    if (!t || t === '# Memory' || t.startsWith('- Add durable cross-session notes')) continue
    // Treat headings and bullets and non-empty lines as candidate entries.
    if (/^#{1,6}\s/.test(t) || /^[-*]\s/.test(t) || t.length > 24) {
      out.push({ text: t, tokens: tokenize(t) })
    }
  }
  return out
}

function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9_.\-/]{3,}/g) ?? []).filter(
    (w) => !STOP.has(w),
  )
}

const STOP = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'are', 'was', 'were',
  'has', 'have', 'not', 'now', 'via', 'into', 'all', 'out', 'use', 'using',
])

/** Search memory entries by query (token overlap), ranked by score. */
export function searchMemory(
  content: string,
  query: string,
  limit = 10,
): Array<{ text: string; score: number }> {
  const q = tokenize(query)
  if (q.length === 0) return []
  const qSet = new Set(q)
  const scored: Array<{ text: string; score: number }> = []
  for (const e of parseMemoryEntries(content)) {
    let score = 0
    for (const tok of e.tokens) if (qSet.has(tok)) score += 1
    if (score > 0) scored.push({ text: e.text, score })
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit)
}

/** Normalize an entry for dedupe comparison: lowercase, collapse whitespace,
 * and strip a leading list marker so "- note" and "note" compare equal. */
function normKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/^\s*[-*+]\s+/, '') // strip one leading bullet marker
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Append a note to memory with dedupe + a size cap. Returns the new content.
 * - If an equivalent entry (normalized) already exists, it's replaced in place
 *   (moved to the end = "most recent") rather than duplicated.
 * - If the file exceeds maxChars, the oldest non-heading entries are pruned.
 */
export function appendMemoryNote(
  content: string,
  note: string,
  opts: { maxChars?: number } = {},
): string {
  const maxChars = Math.max(1000, opts.maxChars ?? 40_000)
  const body = String(content || '').replace(/\r\n/g, '\n').replace(/\s+$/,'')
  const noteLine = note.trim().replace(/\n+/g, ' ').trim()
  const key = normKey(noteLine)

  const lines = body.split('\n')
  // Remove an existing equivalent entry (dedupe).
  const kept = lines.filter((l) => normKey(l) !== key)
  const next = [...kept, '', noteLine].join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'

  if (next.length <= maxChars) return next
  // Prune oldest entries (keep the leading heading + the newest lines) to fit.
  const head: string[] = []
  const tail: string[] = []
  const all = next.split('\n')
  let i = 0
  // Preserve the title block (first heading + immediately following blank/intro).
  for (; i < all.length; i += 1) {
    if (/^#\s/.test(all[i]) || all[i].trim() === '') head.push(all[i])
    else break
  }
  for (let j = all.length - 1; j >= i; j -= 1) {
    tail.unshift(all[j])
    if (tail.join('\n').length > maxChars * 0.9) break
  }
  return [...head, ...tail].join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

/**
 * Build the recall block for the system prompt. When the memory file is small
 * enough it returns the whole thing; otherwise it returns only the entries most
 * relevant to the current user input (plus the file path + edit instructions).
 */
export function recallForPrompt(
  content: string,
  opts: { query?: string; maxChars?: number } = {},
): string {
  const maxChars = Math.max(2000, opts.maxChars ?? 12_000)
  const body = String(content || '')
  if (body.length <= maxChars) return body
  // Too big — return the most relevant slice around the query (or the newest).
  const hits = opts.query ? searchMemory(body, opts.query, 30) : []
  const picked: string[] = []
  let total = 0
  const push = (t: string): boolean => {
    if (total + t.length + 1 > maxChars) return false
    picked.push(t)
    total += t.length + 1
    return true
  }
  if (hits.length > 0) {
    for (const h of hits) if (!push(h.text)) break
  } else {
    // No query — keep the newest entries (tail of the file).
    const entries = parseMemoryEntries(body)
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      if (!push(entries[i].text)) break
    }
    picked.reverse()
  }
  return picked.join('\n')
}
