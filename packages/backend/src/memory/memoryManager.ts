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
 *
 * v3.4.2 additions:
 * - Section-aware parsing: `## Gotchas`, `## Decisions`, `## Estate`, `## Open work`
 *   headings carry through recall so whole coherent sections survive truncation.
 * - Recency-weighted scoring: entries are ranked by (relevance × recency), not
 *   pure token overlap — a 3-month-old note no longer beats yesterday's.
 * - Per-project memory: resolveProjectMemoryPath() maps a working directory to
 *   a scoped memory file that layers ON TOP of the global one.
 */

export interface MemoryEntry {
  /** the raw text of the entry (one bullet/line/block). */
  text: string
  /** lowercased tokens extracted for matching. */
  tokens: string[]
  /** 0-based position in the file (oldest = 0). Used for recency weighting. */
  position: number
  /** the `## Section` this entry lives under, if any. */
  section?: string
}

/** Canonical memory sections. Recall keeps the heading with its entries. */
export const MEMORY_SECTIONS = ['Gotchas', 'Decisions', 'Estate', 'Open work'] as const

/** Split memory markdown into searchable entries (bullets + headings + paragraphs).
 *  v3.4.2: tracks position (for recency) and the ## section each entry is under. */
export function parseMemoryEntries(content: string): MemoryEntry[] {
  const out: MemoryEntry[] = []
  const lines = String(content || '').replace(/\r\n/g, '\n').split('\n')
  let currentSection: string | undefined
  let pos = 0
  for (const line of lines) {
    const t = line.trim()
    if (!t || t === '# Memory' || t.startsWith('- Add durable cross-session notes')) continue
    const sectionMatch = /^##\s+(.+)$/.exec(t)
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim()
      // Headings are entries too (so a section title can be recalled alone).
      out.push({ text: t, tokens: tokenize(t), position: pos, section: currentSection })
      pos += 1
      continue
    }
    if (/^#{1,6}\s/.test(t) || /^[-*]\s/.test(t) || t.length > 24) {
      out.push({ text: t, tokens: tokenize(t), position: pos, section: currentSection })
      pos += 1
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

/**
 * Search memory entries by query, ranked by relevance × recency.
 *
 * v3.4.2: score = tokenOverlap × (0.6 + 0.4 × recency) where recency is
 * position / totalEntries (newest = 1.0). A perfect-match old note still
 * wins, but among equal matches the newer one ranks first.
 */
export function searchMemory(
  content: string,
  query: string,
  limit = 10,
): Array<{ text: string; score: number }> {
  const q = tokenize(query)
  if (q.length === 0) return []
  const qSet = new Set(q)
  const entries = parseMemoryEntries(content)
  const total = Math.max(1, entries.length)
  const scored: Array<{ text: string; score: number }> = []
  for (const e of entries) {
    let overlap = 0
    for (const tok of e.tokens) if (qSet.has(tok)) overlap += 1
    if (overlap === 0) continue
    const recency = e.position / total
    const score = overlap * (0.6 + 0.4 * recency)
    scored.push({ text: e.text, score })
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit)
}

/** Normalize an entry for dedupe comparison: lowercase, collapse whitespace,
 *  and strip a leading list marker so "- note" and "note" compare equal. */
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
  let result = [...head, ...tail].join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
  // Hard truncate any single entry that alone exceeds the cap (e.g. one giant
  // line) — otherwise the head/tail split cannot shrink it.
  if (result.length > maxChars * 1.2) {
    result = result.slice(0, Math.floor(maxChars)) + '\n'
  }
  return result
}

/**
 * Build the recall block for the system prompt. When the memory file is small
 * enough it returns the whole thing; otherwise it returns only the entries most
 * relevant to the current user input (plus the file path + edit instructions).
 *
 * v3.4.2: section-aware — when a recalled entry lives under a `## Section`
 * heading, the heading is included so the block reads as coherent sections
 * rather than scattered lines.
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
  const emittedSections = new Set<string>()
  let total = 0
  const push = (t: string): boolean => {
    if (total + t.length + 1 > maxChars) return false
    picked.push(t)
    total += t.length + 1
    return true
  }
  const pushWithSection = (e: { text: string; section?: string }): boolean => {
    if (e.section && !emittedSections.has(e.section)) {
      const heading = `## ${e.section}`
      if (!push(heading)) return false
      emittedSections.add(e.section)
    }
    return push(e.text)
  }
  if (hits.length > 0) {
    // Map hit text back to its entry so we know the section.
    const byText = new Map<string, MemoryEntry>()
    for (const e of parseMemoryEntries(body)) byText.set(e.text, e)
    for (const h of hits) {
      const e = byText.get(h.text)
      if (e) {
        if (!pushWithSection(e)) break
      } else if (!push(h.text)) {
        break
      }
    }
  } else {
    // No query — keep the newest entries (tail of the file).
    const entries = parseMemoryEntries(body)
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      if (!pushWithSection(entries[i])) break
    }
    picked.reverse()
  }
  return picked.join('\n')
}

// ---------------------------------------------------------------- per-project

/**
 * v3.4.2: map a working directory to a project-scoped memory file path.
 * Returns null for the home directory (no project scope).
 *
 * The project memory LAYERS on top of the global memory: both are injected,
 * project first (it is the more specific context).
 */
export function resolveProjectMemoryPath(
  workingDir: string | null | undefined,
  homeDir: string,
): string | null {
  if (!workingDir) return null
  const wd = workingDir.replace(/\/+$/, '')
  const home = homeDir.replace(/\/+$/, '')
  if (!wd || wd === home) return null
  // Must be inside home.
  if (!wd.startsWith(home + '/')) return null
  // Use the first path segment under home as the project slug (so
  // ~/work/RTerm and ~/work/RTerm/packages both map to "work-rterm").
  const rel = wd.slice(home.length + 1)
  if (!rel) return null
  const firstSeg = rel.split('/')[0]
  if (!firstSeg) return null
  const slug = firstSeg.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase()
  if (!slug) return null
  return `${home}/.gybackend-data/memory/projects/${slug}.md`
}

/** v3.4.2: does a path look like a project memory file (not the global one)? */
export function isProjectMemoryPath(filePath: string): boolean {
  return filePath.includes('/memory/projects/')
}