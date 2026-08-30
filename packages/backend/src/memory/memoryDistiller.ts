/**
 * memoryDistiller — v3.4.2 auto-write memory after task completion.
 *
 * The problem: memory.md only grows when the user explicitly asks. The
 * freeze/lost-work bug (v3.4.1) is exactly the kind of thing that should
 * have been remembered automatically — the work happened, the process died,
 * and nothing was distilled.
 *
 * This runs DETERMINISTICALLY after each completed agent run (no extra LLM
 * call, no extra tokens): it inspects the run's trajectory for the signals
 * that make a note durable — files created, versions released, commands
 * that failed then succeeded, paths that matter — and appends a compact
 * one-line note per signal to memory.md via appendMemoryNote (deduped,
 * capped).
 *
 * Opt-in by default OFF (settings.memory.autoWrite). Operators who want a
 * self-annotating memory turn it on.
 */
import { appendMemoryNote } from './memoryManager'

export interface DistillSignal {
  /** the note to append (one line, no newlines). */
  note: string
  /** which section the note belongs to (Gotchas / Decisions / Estate / Open work). */
  section: 'Gotchas' | 'Decisions' | 'Estate' | 'Open work'
}

export interface DistillInput {
  /** the user's original request for this run (first user message). */
  userRequest: string
  /** tool names invoked during the run, in order (may contain duplicates). */
  toolCalls: string[]
  /** terminal commands executed during the run (already capped upstream). */
  commands: string[]
  /** files written via write_file / edit_file during the run. */
  filesWritten: string[]
  /** non-fatal errors observed during the run (already capped upstream). */
  errors: string[]
  /** exit status of the run. */
  status: 'completed' | 'failed' | 'aborted'
}

const MAX_NOTE_LEN = 160
const MAX_SIGNALS = 3

function clamp(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > MAX_NOTE_LEN ? one.slice(0, MAX_NOTE_LEN - 1) + '\u2026' : one
}

function sectionBody(note: string, section: string): string {
  return `## ${section}\n- ${note}`
}

/**
 * Extract durable signals from a completed run. Pure — no I/O, no LLM.
 * Returns at most MAX_SIGNALS notes, most important first.
 */
export function distillMemoryNotes(input: DistillInput): DistillSignal[] {
  const out: DistillSignal[] = []
  const seen = new Set<string>()
  const add = (note: string, section: DistillSignal['section']) => {
    const key = note.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push({ note: clamp(note), section })
  }

  // 1. A release/version bump is always durable.
  const versionCmd = input.commands.find((c) =>
    /\b(npm publish|git tag|gh release create)\b/.test(c),
  )
  if (versionCmd) {
    // Look for a version in ANY of the run's commands, not just the first
    // matching one (the tag command may be separate from the publish one).
    const tag = input.commands
      .map((c) => /v(\d+\.\d+\.\d+)/.exec(c)?.[1])
      .find(Boolean)
    add(
      tag
        ? `Released v${tag} (${summarizeRequest(input.userRequest)})`
        : `Release executed: ${summarizeRequest(input.userRequest)}`,
      'Decisions',
    )
  }

  // 2. A command that failed then succeeded = a gotcha worth remembering.
  for (const err of input.errors.slice(0, 3)) {
    const brief = /(?:error|failed):\s*(.{10,80})/i.exec(err)?.[1]
    if (brief) add(`Gotcha: ${brief}`, 'Gotchas')
  }

  // 3. Files written repeatedly = estate that matters.
  const freq = new Map<string, number>()
  for (const f of input.filesWritten) {
    const dir = f.split('/').slice(0, -1).join('/')
    if (dir) freq.set(dir, (freq.get(dir) ?? 0) + 1)
  }
  const hotDir = [...freq.entries()].sort((a, b) => b[1] - a[1])[0]
  if (hotDir && hotDir[1] >= 3) {
    add(`Active project dir: ${hotDir[0]} (${hotDir[1]} writes this run)`, 'Estate')
  }

  // 4. A failed run with a clear request is open work.
  if (input.status !== 'completed' && input.userRequest) {
    add(`Unfinished: ${summarizeRequest(input.userRequest)}`, 'Open work')
  }

  return out.slice(0, MAX_SIGNALS)
}

function summarizeRequest(req: string): string {
  const s = String(req || '').replace(/\s+/g, ' ').trim()
  return s.length > 80 ? s.slice(0, 79) + '\u2026' : s
}

/**
 * Apply distilled notes to a memory file body. Returns the new body.
 * Notes are appended under their section heading (created if absent),
 * deduped and capped by appendMemoryNote.
 */
export function applyDistilledNotes(
  content: string,
  notes: DistillSignal[],
  opts: { maxChars?: number } = {},
): string {
  let body = String(content || '')
  for (const n of notes) {
    body = appendMemoryNote(body, sectionBody(n.note, n.section), opts)
  }
  return body
}