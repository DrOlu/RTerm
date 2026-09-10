/**
 * opsStore — SQLite persistence for the v3.8.x operator modules.
 *
 * The pure modules in services/ops (collabSession, approvalQueue, incidentBundle,
 * jumpPath, outputSnapshot) hold their state in module-level Maps, which die with
 * the process. This store is the durable half: incidents, jump paths (with
 * break-glass TTL), output snapshots and approvals survive a restart so a
 * two-person approval or an incident bundle is still there tomorrow.
 *
 * Session-scoped state (who holds the conn, agent replay) stays in memory —
 * those are meaningless across restarts by definition.
 *
 * All methods are best-effort: a store failure must never break an agent run
 * (same contract as CompoundingStore / AgentRunLedger).
 */
import fs from 'node:fs'
import path from 'node:path'
import { openBetterSqlite3Database } from '../history/betterSqlite3Runtime'
import { resolveHistoryStorageDir } from '../history/historyStoragePaths'

type DatabaseHandle = InstanceType<typeof import('better-sqlite3')>

export const OPS_DB_FILE = 'gyshell-ops.sqlite'

export interface IncidentRow {
  id: string
  title: string
  status: 'open' | 'closed'
  sessionId?: string
  tabIds: string[]
  recordingId?: string
  runId?: string
  notes?: string
  openedAt: number
  closedAt?: number
}

export interface JumpPathRow {
  name: string
  hops: Array<{ host: string; user?: string; port?: number }>
  breakGlassUntil?: number
  createdAt: number
}

export interface SnapshotRow {
  connection: string
  command: string
  output: string
  at: number
}

export interface ApprovalRow {
  id: string
  command: string
  state: 'pending' | 'approved' | 'denied' | 'expired'
  twoPerson: boolean
  requestedAt: number
  expiresAt: number
  decidedBy?: string
  decidedAt?: number
}

/** One approval decision. twoPerson approvals need two distinct approvers. */
export interface ApprovalDecision {
  ok: boolean
  approval: ApprovalRow
  reason?: string
}

export class OpsStore {
  private readonly db: DatabaseHandle

  constructor(options?: { filePath?: string }) {
    const filePath = options?.filePath || path.join(resolveHistoryStorageDir(), OPS_DB_FILE)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    this.db = openBetterSqlite3Database(filePath)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS incidents (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        session_id TEXT,
        tab_ids TEXT NOT NULL DEFAULT '[]',
        recording_id TEXT,
        run_id TEXT,
        notes TEXT,
        opened_at INTEGER NOT NULL,
        closed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS jump_paths (
        name TEXT PRIMARY KEY,
        hops TEXT NOT NULL DEFAULT '[]',
        break_glass_until INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        connection TEXT NOT NULL,
        command TEXT NOT NULL,
        output TEXT NOT NULL,
        at INTEGER NOT NULL,
        PRIMARY KEY (connection, command)
      );
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        command TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        two_person INTEGER NOT NULL DEFAULT 0,
        requested_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        decided_by TEXT,
        decided_at INTEGER,
        approvals TEXT NOT NULL DEFAULT '[]'
      );
    `)
  }

  // ── incidents ────────────────────────────────────────────────────────────
  openIncident(title: string, parts: Partial<Omit<IncidentRow, 'id' | 'title' | 'status' | 'openedAt'>> = {}): IncidentRow {
    const row: IncidentRow = {
      id: `inc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      title,
      status: 'open',
      tabIds: parts.tabIds ?? [],
      sessionId: parts.sessionId,
      recordingId: parts.recordingId,
      runId: parts.runId,
      notes: parts.notes,
      openedAt: Date.now(),
    }
    this.db
      .prepare(
        `INSERT INTO incidents (id, title, status, session_id, tab_ids, recording_id, run_id, notes, opened_at)
         VALUES (@id, @title, @status, @sessionId, @tabIds, @recordingId, @runId, @notes, @openedAt)`,
      )
      .run({ ...row, tabIds: JSON.stringify(row.tabIds) })
    return row
  }

  getIncident(id: string): IncidentRow | undefined {
    const r = this.db.prepare(`SELECT * FROM incidents WHERE id = ?`).get(id) as Record<string, unknown> | undefined
    return r ? mapIncident(r) : undefined
  }

  listIncidents(status?: 'open' | 'closed'): IncidentRow[] {
    const rows = (status
      ? this.db.prepare(`SELECT * FROM incidents WHERE status = ? ORDER BY opened_at DESC`).all(status)
      : this.db.prepare(`SELECT * FROM incidents ORDER BY opened_at DESC`).all()) as Array<Record<string, unknown>>
    return rows.map(mapIncident)
  }

  closeIncident(id: string, notes?: string): IncidentRow | undefined {
    this.db
      .prepare(`UPDATE incidents SET status = 'closed', closed_at = ?, notes = COALESCE(?, notes) WHERE id = ?`)
      .run(Date.now(), notes ?? null, id)
    return this.getIncident(id)
  }

  // ── jump paths / break-glass ─────────────────────────────────────────────
  defineJumpPath(name: string, hops: JumpPathRow['hops']): JumpPathRow {
    const row: JumpPathRow = { name, hops, createdAt: Date.now() }
    this.db
      .prepare(
        `INSERT INTO jump_paths (name, hops, break_glass_until, created_at) VALUES (?, ?, NULL, ?)
         ON CONFLICT(name) DO UPDATE SET hops = excluded.hops`,
      )
      .run(name, JSON.stringify(hops), row.createdAt)
    return row
  }

  listJumpPaths(): JumpPathRow[] {
    return (this.db.prepare(`SELECT * FROM jump_paths ORDER BY name`).all() as Array<Record<string, unknown>>).map(
      mapJumpPath,
    )
  }

  /** Grant time-boxed break-glass on a path. */
  grantBreakGlass(name: string, ttlMs: number): JumpPathRow | undefined {
    const until = Date.now() + Math.max(0, ttlMs)
    this.db.prepare(`UPDATE jump_paths SET break_glass_until = ? WHERE name = ?`).run(until, name)
    return this.listJumpPaths().find((p) => p.name === name)
  }

  /** allowed = no break-glass needed, or break-glass still valid. */
  pathAllowed(name: string, now = Date.now()): { allowed: boolean; breakGlassUntil?: number; expired?: boolean } {
    const p = this.listJumpPaths().find((x) => x.name === name)
    if (!p) return { allowed: false }
    if (!p.breakGlassUntil) return { allowed: false }
    const allowed = p.breakGlassUntil > now
    return { allowed, breakGlassUntil: p.breakGlassUntil, expired: !allowed }
  }

  // ── output snapshots ─────────────────────────────────────────────────────
  rememberOutput(connection: string, command: string, output: string, at = Date.now()): SnapshotRow {
    const row: SnapshotRow = { connection, command, output, at }
    this.db
      .prepare(
        `INSERT INTO snapshots (connection, command, output, at) VALUES (@connection, @command, @output, @at)
         ON CONFLICT(connection, command) DO UPDATE SET output = excluded.output, at = excluded.at`,
      )
      .run(row)
    return row
  }

  lastSnapshot(connection: string, command: string): SnapshotRow | undefined {
    const r = this.db
      .prepare(`SELECT * FROM snapshots WHERE connection = ? AND command = ?`)
      .get(connection, command) as Record<string, unknown> | undefined
    return r ? mapSnapshot(r) : undefined
  }

  listSnapshots(connection?: string): SnapshotRow[] {
    const rows = (connection
      ? this.db.prepare(`SELECT * FROM snapshots WHERE connection = ? ORDER BY at DESC`).all(connection)
      : this.db.prepare(`SELECT * FROM snapshots ORDER BY at DESC`)) as Array<Record<string, unknown>>
    return rows.map(mapSnapshot)
  }

  /**
   * Diff the stored output for (connection, command) against nextOutput and
   * remember nextOutput as the new baseline (so the next call diffs again).
   */
  diffAndRemember(
    connection: string,
    command: string,
    nextOutput: string,
  ): { previous: string | null; current: string; changed: boolean } {
    const prev = this.lastSnapshot(connection, command)
    const changed = prev ? prev.output !== nextOutput : false
    this.rememberOutput(connection, command, nextOutput)
    return { previous: prev ? prev.output : null, current: nextOutput, changed }
  }

  // ── approvals (two-person + TTL) ─────────────────────────────────────────
  requestApproval(command: string, ttlMs: number, twoPerson = false, now = Date.now()): ApprovalRow {
    const row: ApprovalRow = {
      id: `ap-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      command,
      state: 'pending',
      twoPerson,
      requestedAt: now,
      expiresAt: now + Math.max(0, ttlMs),
    }
    this.db
      .prepare(
        `INSERT INTO approvals (id, command, state, two_person, requested_at, expires_at, approvals)
         VALUES (@id, @command, @state, @twoPerson, @requestedAt, @expiresAt, '[]')`,
      )
      .run({ ...row, twoPerson: row.twoPerson ? 1 : 0 })
    return row
  }

  getApproval(id: string): ApprovalRow | undefined {
    const r = this.db.prepare(`SELECT * FROM approvals WHERE id = ?`).get(id) as Record<string, unknown> | undefined
    return r ? mapApproval(r) : undefined
  }

  listApprovals(state?: ApprovalRow['state']): ApprovalRow[] {
    const rows = (state
      ? this.db.prepare(`SELECT * FROM approvals WHERE state = ? ORDER BY requested_at DESC`).all(state)
      : this.db.prepare(`SELECT * FROM approvals ORDER BY requested_at DESC`)) as Array<Record<string, unknown>>
    return rows.map(mapApproval)
  }

  private approvers(id: string): string[] {
    const r = this.db.prepare(`SELECT approvals FROM approvals WHERE id = ?`).get(id) as { approvals?: string } | undefined
    try {
      const parsed = JSON.parse(r?.approvals ?? '[]')
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  /** Sweep pending approvals whose TTL has passed into 'expired'. Returns count. */
  sweepExpired(now = Date.now()): number {
    const r = this.db
      .prepare(`UPDATE approvals SET state = 'expired' WHERE state = 'pending' AND expires_at <= ?`)
      .run(now)
    return Number(r.changes ?? 0)
  }

  /**
   * Record a decision. A two-person approval needs TWO DISTINCT approvers before
   * it flips to approved; a denial takes effect immediately. Expired approvals
   * cannot be decided.
   */
  decide(id: string, who: string, approve: boolean, now = Date.now()): ApprovalDecision {
    const a = this.getApproval(id)
    if (!a) throw new Error(`unknown approval ${id}`)
    this.sweepExpired(now)
    const fresh = this.getApproval(id)!
    if (fresh.state === 'expired') return { ok: false, approval: fresh, reason: 'expired' }
    if (fresh.state !== 'pending') return { ok: false, approval: fresh, reason: `already ${fresh.state}` }

    if (!approve) {
      this.db
        .prepare(`UPDATE approvals SET state = 'denied', decided_by = ?, decided_at = ? WHERE id = ?`)
        .run(who, now, id)
      return { ok: false, approval: this.getApproval(id)!, reason: 'denied' }
    }

    const prior = this.approvers(id)
    if (prior.includes(who)) {
      return { ok: false, approval: fresh, reason: `approver "${who}" already approved — a second person is required` }
    }
    const next = [...prior, who]
    const needed = fresh.twoPerson ? 2 : 1
    const approved = next.length >= needed
    this.db
      .prepare(
        `UPDATE approvals SET approvals = ?, state = ?, decided_by = ?, decided_at = ? WHERE id = ?`,
      )
      .run(JSON.stringify(next), approved ? 'approved' : 'pending', who, now, id)
    return {
      ok: approved,
      approval: this.getApproval(id)!,
      reason: approved ? undefined : `need ${needed - next.length} more approver(s)`,
    }
  }
}

function mapIncident(r: Record<string, unknown>): IncidentRow {
  let tabIds: string[] = []
  try {
    const parsed = JSON.parse(String(r.tab_ids ?? '[]'))
    if (Array.isArray(parsed)) tabIds = parsed.map(String)
  } catch {
    tabIds = []
  }
  return {
    id: String(r.id),
    title: String(r.title),
    status: r.status === 'closed' ? 'closed' : 'open',
    sessionId: r.session_id ? String(r.session_id) : undefined,
    tabIds,
    recordingId: r.recording_id ? String(r.recording_id) : undefined,
    runId: r.run_id ? String(r.run_id) : undefined,
    notes: r.notes ? String(r.notes) : undefined,
    openedAt: Number(r.opened_at ?? 0),
    closedAt: r.closed_at ? Number(r.closed_at) : undefined,
  }
}

function mapJumpPath(r: Record<string, unknown>): JumpPathRow {
  let hops: JumpPathRow['hops'] = []
  try {
    const parsed = JSON.parse(String(r.hops ?? '[]'))
    if (Array.isArray(parsed)) hops = parsed as JumpPathRow['hops']
  } catch {
    hops = []
  }
  return {
    name: String(r.name),
    hops,
    breakGlassUntil: r.break_glass_until ? Number(r.break_glass_until) : undefined,
    createdAt: Number(r.created_at ?? 0),
  }
}

function mapSnapshot(r: Record<string, unknown>): SnapshotRow {
  return {
    connection: String(r.connection),
    command: String(r.command),
    output: String(r.output ?? ''),
    at: Number(r.at ?? 0),
  }
}

function mapApproval(r: Record<string, unknown>): ApprovalRow {
  return {
    id: String(r.id),
    command: String(r.command),
    state: (String(r.state) as ApprovalRow['state']) ?? 'pending',
    twoPerson: Number(r.two_person ?? 0) === 1,
    requestedAt: Number(r.requested_at ?? 0),
    expiresAt: Number(r.expires_at ?? 0),
    decidedBy: r.decided_by ? String(r.decided_by) : undefined,
    decidedAt: r.decided_at ? Number(r.decided_at) : undefined,
  }
}
