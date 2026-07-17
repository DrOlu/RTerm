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

  /** Delete a session log + index entry. */
  delete(sessionId: string): void {
    this.stop(sessionId)
    try { fs.unlinkSync(this.logPath(sessionId)) } catch { /* ignore */ }
    const idx = this.readIndex()
    delete idx[sessionId]
    this.writeIndex(idx)
  }
}
