import fs from "node:fs";
import path from "node:path";
import { openBetterSqlite3Database } from "./history/betterSqlite3Runtime";
import { resolveHistoryStorageDir } from "./history/historyStoragePaths";

type DatabaseHandle = InstanceType<typeof import("better-sqlite3")>;

/**
 * Change ledger — the durable record of every MOP-style change run through
 * RTerm. A change moves planned → approved → executing → committed /
 * rolled_back / failed (aborted when the app died mid-run), and every step
 * execution, validation, and rollback action gets its own row, so weeks
 * later operators can answer: what was planned, who approved it, exactly
 * which steps ran on which target, what validation saw, and whether the
 * automatic rollback completed.
 *
 * Storage is SQLite (same native runtime as chat history / the agent run
 * ledger). All methods are best-effort-safe: a ledger failure must never
 * break a change run, so every public method swallows internal errors after
 * logging.
 */

export const CHANGE_LEDGER_FILE_NAME = "gyshell-changes.sqlite";

export type ChangeStatus =
  | "planned"
  | "approved"
  | "executing"
  | "committed"
  | "rolled_back"
  | "failed"
  | "aborted";

export type ChangeStepPhase = "execute" | "validate" | "rollback";

export interface ChangeRecord {
  changeId: string;
  playbookId: string;
  playbookName: string;
  /** JSON snapshot of resolved targets at plan time. */
  targetsSnapshot?: string;
  status: ChangeStatus;
  createdAt: number;
  approvedAt?: number;
  approvedBy?: string;
  startedAt?: number;
  endedAt?: number;
  error?: string;
  /** Playbook run id once execution finished (joins to playbook run history). */
  runId?: string;
}

export interface ChangeStepRecord {
  id: number;
  changeId: string;
  target: string;
  stepIndex: number;
  stepName?: string;
  kind: string;
  phase: ChangeStepPhase;
  ok: boolean;
  detail?: string;
  at: number;
}

const TERMINAL_STATUSES: readonly ChangeStatus[] = ["committed", "rolled_back", "failed", "aborted"];

interface ChangeRow {
  change_id: string;
  playbook_id: string;
  playbook_name: string;
  targets_snapshot: string | null;
  status: string;
  created_at: number;
  approved_at: number | null;
  approved_by: string | null;
  started_at: number | null;
  ended_at: number | null;
  error: string | null;
  run_id: string | null;
}

interface ChangeStepRow {
  id: number;
  change_id: string;
  target: string;
  step_index: number;
  step_name: string | null;
  kind: string;
  phase: string;
  ok: number;
  detail: string | null;
  at: number;
}

export interface ChangeLedgerOptions {
  filePath?: string;
}

export class ChangeLedger {
  private readonly filePath: string;
  private readonly db: DatabaseHandle;

  constructor(options?: ChangeLedgerOptions) {
    this.filePath = options?.filePath || path.join(resolveHistoryStorageDir(), CHANGE_LEDGER_FILE_NAME);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.db = openBetterSqlite3Database(this.filePath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS changes (
        change_id TEXT PRIMARY KEY,
        playbook_id TEXT NOT NULL,
        playbook_name TEXT NOT NULL,
        targets_snapshot TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        approved_at INTEGER,
        approved_by TEXT,
        started_at INTEGER,
        ended_at INTEGER,
        error TEXT,
        run_id TEXT
      );
      CREATE TABLE IF NOT EXISTS change_steps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        change_id TEXT NOT NULL REFERENCES changes(change_id) ON DELETE CASCADE,
        target TEXT NOT NULL,
        step_index INTEGER NOT NULL,
        step_name TEXT,
        kind TEXT NOT NULL,
        phase TEXT NOT NULL,
        ok INTEGER NOT NULL,
        detail TEXT,
        at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_change_steps_change ON change_steps(change_id);
      CREATE INDEX IF NOT EXISTS idx_changes_status ON changes(status);
      CREATE INDEX IF NOT EXISTS idx_changes_created ON changes(created_at);
    `);
  }

  private rowToRecord(row: ChangeRow): ChangeRecord {
    return {
      changeId: row.change_id,
      playbookId: row.playbook_id,
      playbookName: row.playbook_name,
      targetsSnapshot: row.targets_snapshot ?? undefined,
      status: row.status as ChangeStatus,
      createdAt: row.created_at,
      approvedAt: row.approved_at ?? undefined,
      approvedBy: row.approved_by ?? undefined,
      startedAt: row.started_at ?? undefined,
      endedAt: row.ended_at ?? undefined,
      error: row.error ?? undefined,
      runId: row.run_id ?? undefined,
    };
  }

  private stepRowToRecord(row: ChangeStepRow): ChangeStepRecord {
    return {
      id: row.id,
      changeId: row.change_id,
      target: row.target,
      stepIndex: row.step_index,
      stepName: row.step_name ?? undefined,
      kind: row.kind,
      phase: row.phase as ChangeStepPhase,
      ok: row.ok === 1,
      detail: row.detail ?? undefined,
      at: row.at,
    };
  }

  /** Insert a planned change. Idempotent on changeId. */
  createChange(input: {
    changeId: string;
    playbookId: string;
    playbookName: string;
    targetsSnapshot?: string;
    createdAt?: number;
  }): void {
    try {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO changes
             (change_id, playbook_id, playbook_name, targets_snapshot, status, created_at)
           VALUES (?, ?, ?, ?, 'planned', ?)`,
        )
        .run(
          input.changeId,
          input.playbookId,
          input.playbookName,
          input.targetsSnapshot ?? null,
          input.createdAt ?? Date.now(),
        );
    } catch (error) {
      console.error("[ChangeLedger] createChange failed:", error);
    }
  }

  /** planned → approved. No-op (returns false) unless currently planned. */
  approveChange(changeId: string, approvedBy?: string, at?: number): boolean {
    try {
      const res = this.db
        .prepare(
          `UPDATE changes SET status='approved', approved_at=?, approved_by=?
           WHERE change_id=? AND status='planned'`,
        )
        .run(at ?? Date.now(), approvedBy ?? null, changeId);
      return res.changes > 0;
    } catch (error) {
      console.error("[ChangeLedger] approveChange failed:", error);
      return false;
    }
  }

  /** approved → executing. No-op (returns false) unless currently approved. */
  markExecuting(changeId: string, at?: number): boolean {
    try {
      const res = this.db
        .prepare(`UPDATE changes SET status='executing', started_at=? WHERE change_id=? AND status='approved'`)
        .run(at ?? Date.now(), changeId);
      return res.changes > 0;
    } catch (error) {
      console.error("[ChangeLedger] markExecuting failed:", error);
      return false;
    }
  }

  /** executing → terminal status. Terminal statuses are never overwritten. */
  finishChange(changeId: string, status: ChangeStatus, error?: string, runId?: string, at?: number): void {
    try {
      if (TERMINAL_STATUSES.includes(status)) {
        this.db
          .prepare(
            `UPDATE changes SET status=?, ended_at=?, error=?, run_id=?
             WHERE change_id=? AND status='executing'`,
          )
          .run(status, at ?? Date.now(), error ?? null, runId ?? null, changeId);
      } else {
        this.db
          .prepare(`UPDATE changes SET status=? WHERE change_id=? AND status NOT IN ('committed','rolled_back','failed','aborted')`)
          .run(status, changeId);
      }
    } catch (err) {
      console.error("[ChangeLedger] finishChange failed:", err);
    }
  }

  /** Append one step/validation/rollback outcome row. */
  recordStep(input: {
    changeId: string;
    target: string;
    stepIndex: number;
    stepName?: string;
    kind: string;
    phase: ChangeStepPhase;
    ok: boolean;
    detail?: string;
    at?: number;
  }): void {
    try {
      this.db
        .prepare(
          `INSERT INTO change_steps (change_id, target, step_index, step_name, kind, phase, ok, detail, at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.changeId,
          input.target,
          input.stepIndex,
          input.stepName ?? null,
          input.kind,
          input.phase,
          input.ok ? 1 : 0,
          input.detail ? input.detail.slice(0, 4000) : null,
          input.at ?? Date.now(),
        );
    } catch (error) {
      console.error("[ChangeLedger] recordStep failed:", error);
    }
  }

  getChange(changeId: string): { change: ChangeRecord; steps: ChangeStepRecord[] } | undefined {
    try {
      const row = this.db.prepare(`SELECT * FROM changes WHERE change_id=?`).get(changeId) as ChangeRow | undefined;
      if (!row) return undefined;
      const steps = this.db
        .prepare(`SELECT * FROM change_steps WHERE change_id=? ORDER BY id ASC`)
        .all(changeId) as ChangeStepRow[];
      return { change: this.rowToRecord(row), steps: steps.map((s) => this.stepRowToRecord(s)) };
    } catch (error) {
      console.error("[ChangeLedger] getChange failed:", error);
      return undefined;
    }
  }

  listChanges(filter?: { status?: ChangeStatus; playbookId?: string; limit?: number }): ChangeRecord[] {
    try {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (filter?.status) {
        clauses.push("status=?");
        params.push(filter.status);
      }
      if (filter?.playbookId) {
        clauses.push("playbook_id=?");
        params.push(filter.playbookId);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const limit = Math.max(1, Math.min(filter?.limit ?? 50, 500));
      const rows = this.db
        .prepare(`SELECT * FROM changes ${where} ORDER BY created_at DESC LIMIT ?`)
        .all(...params, limit) as ChangeRow[];
      return rows.map((r) => this.rowToRecord(r));
    } catch (error) {
      console.error("[ChangeLedger] listChanges failed:", error);
      return [];
    }
  }

  /** Close any change left 'executing' (or planned/approved never run) from a
   * previous process as aborted. Called once at startup. */
  markStaleChangesAborted(at?: number): number {
    try {
      const res = this.db
        .prepare(
          `UPDATE changes SET status='aborted', ended_at=?, error=COALESCE(error, 'process exited before completion')
           WHERE status IN ('executing')`,
        )
        .run(at ?? Date.now());
      return res.changes;
    } catch (error) {
      console.error("[ChangeLedger] markStaleChangesAborted failed:", error);
      return 0;
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch (error) {
      console.error("[ChangeLedger] close failed:", error);
    }
  }
}
