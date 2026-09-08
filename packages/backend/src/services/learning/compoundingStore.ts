/**
 * SQLite store for compounding knowledge: lessons (with occurrence counts),
 * estate facts (per connection identity, not IP), goals, and session probes.
 *
 * All public methods are best-effort — a store failure must never break an
 * agent run (same contract as AgentRunLedger).
 */
import fs from 'node:fs'
import path from 'node:path'
import { openBetterSqlite3Database } from '../history/betterSqlite3Runtime'
import { resolveHistoryStorageDir } from '../history/historyStoragePaths'
import type { ExtractedLesson } from './compoundingKnowledge'

type DatabaseHandle = InstanceType<typeof import('better-sqlite3')>

export const COMPOUNDING_DB_FILE = 'gyshell-compounding.sqlite'

export interface LessonRow {
  fingerprint: string
  title: string
  body: string
  neverDo: string
  instead: string
  tags: string
  extractor: string
  occurrences: number
  firstSeenAt: number
  lastSeenAt: number
  lastRunId?: string
}

export interface EstateFactRow {
  identity: string
  host?: string
  role?: string
  domain?: string
  transport?: string
  auth?: string
  factsJson: string
  lastSeenAt: number
}

export interface GoalRow {
  id: string
  sessionId: string
  text: string
  status: 'open' | 'blocked' | 'done' | 'abandoned'
  blockedBy?: string
  nextProbe?: string
  updatedAt: number
}

export class CompoundingStore {
  private readonly filePath: string
  private readonly db: DatabaseHandle
  /** Avoid sync SQLite on every agent turn (desktop freeze). Invalidated on writes. */
  private promptCache: { at: number; text: string } | null = null
  private static readonly PROMPT_CACHE_MS = 2000

  constructor(options?: { filePath?: string }) {
    this.filePath = options?.filePath || path.join(resolveHistoryStorageDir(), COMPOUNDING_DB_FILE)
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    this.db = openBetterSqlite3Database(this.filePath)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS lessons (
        fingerprint TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        never_do TEXT NOT NULL,
        instead TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '',
        extractor TEXT NOT NULL,
        occurrences INTEGER NOT NULL DEFAULT 1,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        last_run_id TEXT
      );
      CREATE TABLE IF NOT EXISTS estate_facts (
        identity TEXT PRIMARY KEY,
        host TEXT,
        role TEXT,
        domain TEXT,
        transport TEXT,
        auth TEXT,
        facts_json TEXT NOT NULL DEFAULT '{}',
        last_seen_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS goals (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        blocked_by TEXT,
        next_probe TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_goals_session ON goals(session_id);
      CREATE TABLE IF NOT EXISTS probes (
        session_id TEXT NOT NULL,
        tag TEXT NOT NULL,
        hypothesis TEXT NOT NULL,
        command TEXT NOT NULL,
        ok INTEGER NOT NULL,
        at INTEGER NOT NULL,
        PRIMARY KEY (session_id, tag)
      );
    `)
  }

  recordLessons(lessons: ExtractedLesson[], runId?: string): LessonRow[] {
    const now = Date.now()
    const out: LessonRow[] = []
    this.promptCache = null
    try {
      const sel = this.db.prepare('SELECT * FROM lessons WHERE fingerprint = ?')
      const ins = this.db.prepare(
        `INSERT INTO lessons (fingerprint, title, body, never_do, instead, tags, extractor, occurrences, first_seen_at, last_seen_at, last_run_id)
         VALUES (@fingerprint, @title, @body, @neverDo, @instead, @tags, @extractor, 1, @now, @now, @runId)`,
      )
      const upd = this.db.prepare(
        `UPDATE lessons SET occurrences = occurrences + 1, last_seen_at = @now, last_run_id = @runId,
          title = @title, body = @body, never_do = @neverDo, instead = @instead WHERE fingerprint = @fingerprint`,
      )
      for (const l of lessons) {
        const existing = sel.get(l.fingerprint) as any
        if (existing) {
          upd.run({
            fingerprint: l.fingerprint,
            now,
            runId: runId ?? null,
            title: l.title,
            body: l.body,
            neverDo: l.neverDo,
            instead: l.instead,
          })
        } else {
          ins.run({
            fingerprint: l.fingerprint,
            title: l.title,
            body: l.body,
            neverDo: l.neverDo,
            instead: l.instead,
            tags: l.tags.join(','),
            extractor: l.extractor,
            now,
            runId: runId ?? null,
          })
        }
        const row = sel.get(l.fingerprint) as any
        if (row) out.push(this.mapLesson(row))
      }
    } catch (err) {
      console.warn('[CompoundingStore] recordLessons failed:', err)
    }
    return out
  }

  listLessons(limit = 50): LessonRow[] {
    try {
      const rows = this.db
        .prepare('SELECT * FROM lessons ORDER BY last_seen_at DESC LIMIT ?')
        .all(limit) as any[]
      return rows.map((r) => this.mapLesson(r))
    } catch (err) {
      console.warn('[CompoundingStore] listLessons failed:', err)
      return []
    }
  }

  upsertEstateFact(input: {
    identity: string
    host?: string
    role?: string
    domain?: string
    transport?: string
    auth?: string
    facts?: Record<string, unknown>
  }): void {
    this.promptCache = null
    try {
      const now = Date.now()
      this.db
        .prepare(
          `INSERT INTO estate_facts (identity, host, role, domain, transport, auth, facts_json, last_seen_at)
           VALUES (@identity, @host, @role, @domain, @transport, @auth, @facts, @now)
           ON CONFLICT(identity) DO UPDATE SET
             host = COALESCE(@host, host),
             role = COALESCE(@role, role),
             domain = COALESCE(@domain, domain),
             transport = COALESCE(@transport, transport),
             auth = COALESCE(@auth, auth),
             facts_json = CASE WHEN @facts = '{}' THEN facts_json ELSE @facts END,
             last_seen_at = @now`,
        )
        .run({
          identity: input.identity,
          host: input.host ?? null,
          role: input.role ?? null,
          domain: input.domain ?? null,
          transport: input.transport ?? null,
          auth: input.auth ?? null,
          facts: JSON.stringify(input.facts || {}),
          now,
        })
    } catch (err) {
      console.warn('[CompoundingStore] upsertEstateFact failed:', err)
    }
  }

  listEstateFacts(): EstateFactRow[] {
    try {
      const rows = this.db.prepare('SELECT * FROM estate_facts ORDER BY last_seen_at DESC').all() as any[]
      return rows.map((r) => ({
        identity: r.identity,
        host: r.host ?? undefined,
        role: r.role ?? undefined,
        domain: r.domain ?? undefined,
        transport: r.transport ?? undefined,
        auth: r.auth ?? undefined,
        factsJson: r.facts_json,
        lastSeenAt: r.last_seen_at,
      }))
    } catch (err) {
      console.warn('[CompoundingStore] listEstateFacts failed:', err)
      return []
    }
  }

  upsertGoal(input: {
    id: string
    sessionId: string
    text: string
    status: GoalRow['status']
    blockedBy?: string
    nextProbe?: string
  }): void {
    this.promptCache = null
    try {
      this.db
        .prepare(
          `INSERT INTO goals (id, session_id, text, status, blocked_by, next_probe, updated_at)
           VALUES (@id, @sessionId, @text, @status, @blockedBy, @nextProbe, @now)
           ON CONFLICT(id) DO UPDATE SET
             text = @text, status = @status, blocked_by = @blockedBy, next_probe = @nextProbe, updated_at = @now`,
        )
        .run({
          id: input.id,
          sessionId: input.sessionId,
          text: input.text,
          status: input.status,
          blockedBy: input.blockedBy ?? null,
          nextProbe: input.nextProbe ?? null,
          now: Date.now(),
        })
    } catch (err) {
      console.warn('[CompoundingStore] upsertGoal failed:', err)
    }
  }

  listGoals(sessionId: string): GoalRow[] {
    try {
      const rows = this.db
        .prepare('SELECT * FROM goals WHERE session_id = ? ORDER BY updated_at DESC')
        .all(sessionId) as any[]
      return rows.map((r) => ({
        id: r.id,
        sessionId: r.session_id,
        text: r.text,
        status: r.status,
        blockedBy: r.blocked_by ?? undefined,
        nextProbe: r.next_probe ?? undefined,
        updatedAt: r.updated_at,
      }))
    } catch (err) {
      console.warn('[CompoundingStore] listGoals failed:', err)
      return []
    }
  }

  recordProbe(sessionId: string, tag: string, hypothesis: string, command: string, ok: boolean): void {
    this.promptCache = null
    try {
      this.db
        .prepare(
          `INSERT INTO probes (session_id, tag, hypothesis, command, ok, at)
           VALUES (@sessionId, @tag, @hypothesis, @command, @ok, @at)
           ON CONFLICT(session_id, tag) DO UPDATE SET hypothesis = @hypothesis, command = @command, ok = @ok, at = @at`,
        )
        .run({
          sessionId,
          tag,
          hypothesis,
          command,
          ok: ok ? 1 : 0,
          at: Date.now(),
        })
    } catch (err) {
      console.warn('[CompoundingStore] recordProbe failed:', err)
    }
  }

  hasProbe(sessionId: string, tag: string): boolean {
    try {
      const row = this.db
        .prepare('SELECT 1 FROM probes WHERE session_id = ? AND tag = ?')
        .get(sessionId, tag)
      return !!row
    } catch (err) {
      console.warn('[CompoundingStore] hasProbe failed:', err)
      return false
    }
  }

  /**
   * Prompt block: estate snapshot + never-do list from lessons (capped).
   */
  promptBlock(maxChars = 4000): string {
    try {
      const now = Date.now()
      if (this.promptCache && now - this.promptCache.at < CompoundingStore.PROMPT_CACHE_MS) {
        const cached = this.promptCache.text
        return cached.length > maxChars ? cached.slice(0, maxChars) + '\n…' : cached
      }
      const lessons = this.listLessons(20)
      const facts = this.listEstateFacts()
      const lines: string[] = ['# Compounding knowledge (auto)']
      if (facts.length) {
        lines.push('', '## Estate')
        for (const f of facts.slice(0, 12)) {
          const bits = [f.identity]
          if (f.role) bits.push(f.role)
          if (f.domain) bits.push(f.domain)
          if (f.transport || f.auth) bits.push([f.transport, f.auth].filter(Boolean).join('/'))
          lines.push(`- ${bits.join(' · ')}`)
        }
      }
      if (lessons.length) {
        lines.push('', '## Never-do (from prior failures)')
        for (const l of lessons.slice(0, 12)) {
          lines.push(`- [${l.fingerprint} ×${l.occurrences}] NEVER: ${l.neverDo}`)
          lines.push(`  INSTEAD: ${l.instead}`)
        }
      }
      const text = lines.join('\n')
      this.promptCache = { at: now, text }
      return text.length > maxChars ? text.slice(0, maxChars) + '\n…' : text
    } catch {
      return ''
    }
  }

  close(): void {
    try {
      this.db.close()
    } catch {
      /* ignore */
    }
  }

  private mapLesson(r: any): LessonRow {
    return {
      fingerprint: r.fingerprint,
      title: r.title,
      body: r.body,
      neverDo: r.never_do,
      instead: r.instead,
      tags: r.tags,
      extractor: r.extractor,
      occurrences: r.occurrences,
      firstSeenAt: r.first_seen_at,
      lastSeenAt: r.last_seen_at,
      lastRunId: r.last_run_id ?? undefined,
    }
  }
}
