import fs from 'node:fs'
import path from 'node:path'

/**
 * Records terminal session output to disk, per ptyId (session), so operators
 * can review what happened on a connection after the fact — Netcatty's
 * "connection logs" / NetStacks' "session recording" (text subset; no timing
 * replay in v1).
 *
 * Writes are append-only to <logDir>/<sessionId>.log, plus a small JSON index
 * for the UI listing sessions. The log directory defaults to userData under
 * Electron; tests pass an explicit temp dir.
 */
export interface SessionLogServiceOptions {
  logDir: string
}

export interface SessionLogRecord {
  sessionId: string
  /** Connection host/title for display. */
  title: string
  /** Connection type (ssh/winrm/serial). */
  type: string
  startedAt: string
  endedAt?: string
  bytes: number
}

export interface SessionLogSearchOptions {
  /** Restrict to a single sessionId. */
  sessionId?: string
  /** Restrict to sessions whose title/host contains this substring. */
  host?: string
  /** ISO date — only sessions started at/after this time. */
  since?: string
  /** ISO date — only sessions started at/before this time. */
  until?: string
  /** Treat query as a regular expression (default: literal substring). */
  regex?: boolean
  /** Case-sensitive matching (default: false). */
  caseSensitive?: boolean
  /** Max matching lines to return (default: 50). */
  maxMatches?: number
  /** Lines of surrounding context to include per match (default: 0). */
  contextLines?: number
}

export interface SessionLogSearchMatch {
  sessionId: string
  title: string
  type: string
  startedAt: string
  /** 1-based line number within the session log. */
  line: number
  /** The matched line (ANSI-stripped). */
  text: string
  contextBefore: string[]
  contextAfter: string[]
}

export interface SessionLogSearchResult {
  query: string
  matches: SessionLogSearchMatch[]
  sessionsSearched: number
  totalMatches: number
}

export class SessionLogService {
  private readonly logDir: string
  private readonly active = new Map<string, { fd: number; record: SessionLogRecord }>()

  constructor(opts: SessionLogServiceOptions) {
    this.logDir = opts.logDir
    fs.mkdirSync(this.logDir, { recursive: true })
  }

  private logPath(sessionId: string): string {
    return path.join(this.logDir, `${sessionId}.log`)
  }

  private indexPath(): string {
    return path.join(this.logDir, 'index.json')
  }

  private readIndex(): Record<string, SessionLogRecord> {
    try {
      return JSON.parse(fs.readFileSync(this.indexPath(), 'utf8')) as Record<string, SessionLogRecord>
    } catch {
      return {}
    }
  }

  private writeIndex(idx: Record<string, SessionLogRecord>): void {
    fs.writeFileSync(this.indexPath(), JSON.stringify(idx, null, 2))
  }

  /** Start recording a session. Appends if a log for the id already exists. */
  start(sessionId: string, meta: { title: string; type: string }): void {
    if (this.active.has(sessionId)) return
    const fd = fs.openSync(this.logPath(sessionId), 'a')
    const record: SessionLogRecord = {
      sessionId,
      title: meta.title,
      type: meta.type,
      startedAt: new Date().toISOString(),
      bytes: 0,
    }
    // Preserve start time if resuming an existing log entry.
    const idx = this.readIndex()
    if (idx[sessionId]) record.startedAt = idx[sessionId].startedAt
    this.active.set(sessionId, { fd, record })
  }

  /** Append a chunk of terminal output to the session log. */
  write(sessionId: string, data: string): void {
    const a = this.active.get(sessionId)
    if (!a) return
    fs.writeSync(a.fd, data)
    a.record.bytes += Buffer.byteLength(data, 'utf8')
  }

  /** Stop recording; flushes + updates the index. */
  stop(sessionId: string): void {
    const a = this.active.get(sessionId)
    if (!a) return
    a.record.endedAt = new Date().toISOString()
    const idx = this.readIndex()
    idx[sessionId] = { ...idx[sessionId], ...a.record }
    this.writeIndex(idx)
    fs.closeSync(a.fd)
    this.active.delete(sessionId)
  }

  /** List all recorded sessions (from the index). */
  list(): SessionLogRecord[] {
    return Object.values(this.readIndex()).sort((a, b) =>
      (b.startedAt || '').localeCompare(a.startedAt || ''),
    )
  }

  /** Read a session log file fully (for the log viewer). */
  read(sessionId: string): string {
    try {
      return fs.readFileSync(this.logPath(sessionId), 'utf8')
    } catch {
      return ''
    }
  }

  /**
   * Search all recorded session logs for a substring or regex.
   * Returns matching lines with their session context, newest sessions first.
   *
   * The terminal transcript embeds ANSI escape sequences; matches are reported
   * against the raw line (so control bytes in a line are tolerated) but the
   * returned line text is stripped of ANSI codes for readability.
   */
  search(query: string, opts?: SessionLogSearchOptions): SessionLogSearchResult {
    const out: SessionLogSearchResult = { query, matches: [], sessionsSearched: 0, totalMatches: 0 }
    if (!query || !query.trim()) return out

    // Build the matcher. Plain substring by default; regex when asked.
    let test: (line: string) => boolean
    if (opts?.regex) {
      let re: RegExp
      try {
        re = new RegExp(query, opts.caseSensitive ? 'g' : 'gi')
      } catch {
        // Invalid regex — fall back to literal substring so the tool never throws.
        const needle = opts.caseSensitive ? query : query.toLowerCase()
        test = (line) => (opts.caseSensitive ? line : line.toLowerCase()).includes(needle)
        return this.runSearch(test, query, opts, out)
      }
      test = (line) => { re.lastIndex = 0; return re.test(line) }
    } else {
      const needle = opts?.caseSensitive ? query : query.toLowerCase()
      test = (line) => (opts?.caseSensitive ? line : line.toLowerCase()).includes(needle)
    }
    return this.runSearch(test, query, opts, out)
  }

  private runSearch(
    test: (line: string) => boolean,
    _query: string,
    opts: SessionLogSearchOptions | undefined,
    out: SessionLogSearchResult,
  ): SessionLogSearchResult {
    const maxMatches = Math.max(1, opts?.maxMatches ?? 50)
    const contextLines = Math.max(0, opts?.contextLines ?? 0)
    const records = this.list().filter((r) =>
      (!opts?.sessionId || r.sessionId === opts.sessionId) &&
      (!opts?.host || (r.title || '').toLowerCase().includes(opts.host.toLowerCase())),
    )
    const sinceMs = opts?.since ? Date.parse(opts.since) : NaN
    const untilMs = opts?.until ? Date.parse(opts.until) : NaN

    for (const rec of records) {
      if (!Number.isNaN(sinceMs) && Date.parse(rec.startedAt) < sinceMs) continue
      if (!Number.isNaN(untilMs) && Date.parse(rec.startedAt) > untilMs) continue
      out.sessionsSearched++
      const content = this.read(rec.sessionId)
      if (!content) continue
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (out.totalMatches >= maxMatches) return out
        if (!test(lines[i])) continue
        const ctxBefore: string[] = []
        const ctxAfter: string[] = []
        for (let b = Math.max(0, i - contextLines); b < i; b++) ctxBefore.push(SessionLogService.stripAnsi(lines[b]))
        for (let a = i + 1; a <= Math.min(lines.length - 1, i + contextLines); a++) ctxAfter.push(SessionLogService.stripAnsi(lines[a]))
        out.matches.push({
          sessionId: rec.sessionId,
          title: rec.title,
          type: rec.type,
          startedAt: rec.startedAt,
          line: i + 1,
          text: SessionLogService.stripAnsi(lines[i]),
          contextBefore: ctxBefore,
          contextAfter: ctxAfter,
        })
        out.totalMatches++
      }
    }
    return out
  }

  /** Remove ANSI/VT escape sequences so matched lines render readably. */
  private static stripAnsi(input: string): string {
    // eslint-disable-next-line no-control-regex
    return input.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '').replace(/\r/g, '')
  }

  /** Delete a session log + index entry. */
  delete(sessionId: string): void {
    this.stop(sessionId)
    try { fs.unlinkSync(this.logPath(sessionId)) } catch { /* ignore */ }
    const idx = this.readIndex()
    delete idx[sessionId]
    this.writeIndex(idx)
  }
}
