import fs from "node:fs";
import path from "node:path";
import { openBetterSqlite3Database } from "./history/betterSqlite3Runtime";
import { resolveHistoryStorageDir } from "./history/historyStoragePaths";

type DatabaseHandle = InstanceType<typeof import("better-sqlite3")>;

/**
 * Agent run ledger — the persisted audit + token-cost record of every agent
 * run. Each run gets one row (lifecycle: started → completed/failed/aborted)
 * plus one row per model-usage event, so operators can answer "what did the
 * agent do, when, on which session, and how many tokens did it burn?" long
 * after the chat UI has forgotten.
 *
 * Storage is SQLite (same native runtime as chat history) so the ledger
 * survives restarts, is queryable with any SQLite tool, and never needs a
 * server. All methods are best-effort-safe: a ledger failure must never break
 * an agent run, so every public method swallows internal errors after
 * logging.
 */

export const AGENT_RUN_LEDGER_FILE_NAME = "gyshell-agent-runs.sqlite";

export type AgentRunStatus = "running" | "completed" | "failed" | "aborted";

export interface AgentRunRecord {
  runId: string;
  sessionId: string;
  profileId?: string;
  model?: string;
  inputPreview?: string;
  startedAt: number;
  endedAt?: number;
  status: AgentRunStatus;
  error?: string;
  /** Sum of prompt/input tokens across usage events (when reported). */
  promptTokens: number;
  /** Sum of completion/output tokens across usage events (when reported). */
  completionTokens: number;
  /** Last reported full-context token count (cumulative, not summed). */
  lastTotalTokens: number;
  /** Number of model-usage events recorded for this run. */
  usageEvents: number;
}

export interface AgentRunUsageEvent {
  id: number;
  runId: string;
  at: number;
  model?: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens?: number;
}

export interface AgentRunSummary {
  totalRuns: number;
  completedRuns: number;
  failedRuns: number;
  abortedRuns: number;
  promptTokens: number;
  completionTokens: number;
  byModel: Array<{ model: string; runs: number; promptTokens: number; completionTokens: number }>;
}

interface RunRow {
  run_id: string;
  session_id: string;
  profile_id: string | null;
  model: string | null;
  input_preview: string | null;
  started_at: number;
  ended_at: number | null;
  status: string;
  error: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  last_total_tokens: number;
  usage_events: number;
}

/** Extract prompt/completion token counts from a provider usage object.
 * Supports OpenAI-style (prompt_tokens/completion_tokens) and Anthropic-style
 * (input_tokens/output_tokens) shapes; missing fields become 0. */
export function extractUsageTokenBreakdown(usage: unknown): {
  promptTokens: number;
  completionTokens: number;
} {
  const u = (usage ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
  const prompt = num(u.prompt_tokens) || num(u.input_tokens) || num(u.promptTokens) || num(u.inputTokens);
  const completion = num(u.completion_tokens) || num(u.output_tokens) || num(u.completionTokens) || num(u.outputTokens);
  return { promptTokens: prompt, completionTokens: completion };
}

export interface AgentRunLedgerOptions {
  filePath?: string;
}

export class AgentRunLedger {
  private readonly filePath: string;
  private readonly db: DatabaseHandle;

  constructor(options?: AgentRunLedgerOptions) {
    this.filePath =
      options?.filePath ||
      path.join(resolveHistoryStorageDir(), AGENT_RUN_LEDGER_FILE_NAME);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.db = openBetterSqlite3Database(this.filePath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        profile_id TEXT,
        model TEXT,
        input_preview TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        status TEXT NOT NULL,
        error TEXT,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        last_total_tokens INTEGER NOT NULL DEFAULT 0,
        usage_events INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs(started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id);
      CREATE TABLE IF NOT EXISTS usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        model TEXT,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER,
        FOREIGN KEY (run_id) REFERENCES runs(run_id)
      );
      CREATE INDEX IF NOT EXISTS idx_usage_run ON usage_events(run_id);
    `);
  }

  /** Record the start of an agent run. Idempotent per runId. */
  startRun(input: {
    runId: string;
    sessionId: string;
    profileId?: string;
    model?: string;
    inputPreview?: string;
    startedAt?: number;
  }): void {
    try {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO runs (run_id, session_id, profile_id, model, input_preview, started_at, status)
           VALUES (?, ?, ?, ?, ?, ?, 'running')`,
        )
        .run(
          input.runId,
          input.sessionId,
          input.profileId ?? null,
          input.model ?? null,
          (input.inputPreview ?? "").slice(0, 500) || null,
          input.startedAt ?? Date.now(),
        );
    } catch (error) {
      console.warn("[AgentRunLedger] startRun failed:", error);
    }
  }

  /** Record one model-usage event against a run and update its aggregates. */
  recordUsage(
    runId: string,
    usage: { model?: string; promptTokens?: number; completionTokens?: number; totalTokens?: number },
  ): void {
    try {
      const prompt = Math.max(0, Math.floor(usage.promptTokens ?? 0));
      const completion = Math.max(0, Math.floor(usage.completionTokens ?? 0));
      const total =
        typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens)
          ? Math.floor(usage.totalTokens)
          : null;
      this.db
        .prepare(
          `INSERT INTO usage_events (run_id, at, model, prompt_tokens, completion_tokens, total_tokens)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(runId, Date.now(), usage.model ?? null, prompt, completion, total);
      this.db
        .prepare(
          `UPDATE runs SET
             prompt_tokens = prompt_tokens + ?,
             completion_tokens = completion_tokens + ?,
             last_total_tokens = COALESCE(?, last_total_tokens),
             usage_events = usage_events + 1,
             model = COALESCE(?, model)
           WHERE run_id = ?`,
        )
        .run(prompt, completion, total, usage.model ?? null, runId);
    } catch (error) {
      console.warn("[AgentRunLedger] recordUsage failed:", error);
    }
  }

  /** Close out a run. Statuses other than 'running' are terminal (a later
   * finish never overwrites an earlier terminal state). */
  finishRun(runId: string, status: Exclude<AgentRunStatus, "running">, error?: string): void {
    try {
      this.db
        .prepare(
          `UPDATE runs SET status = ?, ended_at = ?, error = ?
           WHERE run_id = ? AND status = 'running'`,
        )
        .run(status, Date.now(), error ?? null, runId);
    } catch (err) {
      console.warn("[AgentRunLedger] finishRun failed:", err);
    }
  }

  private rowToRecord(row: RunRow): AgentRunRecord {
    return {
      runId: row.run_id,
      sessionId: row.session_id,
      profileId: row.profile_id ?? undefined,
      model: row.model ?? undefined,
      inputPreview: row.input_preview ?? undefined,
      startedAt: row.started_at,
      endedAt: row.ended_at ?? undefined,
      status: row.status as AgentRunStatus,
      error: row.error ?? undefined,
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
      lastTotalTokens: row.last_total_tokens,
      usageEvents: row.usage_events,
    };
  }

  /** List runs newest-first. */
  listRuns(filter?: { limit?: number; sessionId?: string; status?: AgentRunStatus }): AgentRunRecord[] {
    try {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (filter?.sessionId) {
        clauses.push("session_id = ?");
        params.push(filter.sessionId);
      }
      if (filter?.status) {
        clauses.push("status = ?");
        params.push(filter.status);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const limit = Math.max(1, Math.min(1000, filter?.limit ?? 50));
      const rows = this.db
        .prepare(`SELECT * FROM runs ${where} ORDER BY started_at DESC LIMIT ?`)
        .all(...params, limit) as RunRow[];
      return rows.map((r) => this.rowToRecord(r));
    } catch (error) {
      console.warn("[AgentRunLedger] listRuns failed:", error);
      return [];
    }
  }

  /** One run plus its usage events. */
  getRun(runId: string): { run: AgentRunRecord; usage: AgentRunUsageEvent[] } | null {
    try {
      const row = this.db.prepare(`SELECT * FROM runs WHERE run_id = ?`).get(runId) as RunRow | undefined;
      if (!row) return null;
      const usage = this.db
        .prepare(`SELECT * FROM usage_events WHERE run_id = ? ORDER BY at ASC, id ASC`)
        .all(runId) as Array<{
        id: number; run_id: string; at: number; model: string | null;
        prompt_tokens: number; completion_tokens: number; total_tokens: number | null;
      }>;
      return {
        run: this.rowToRecord(row),
        usage: usage.map((u) => ({
          id: u.id,
          runId: u.run_id,
          at: u.at,
          model: u.model ?? undefined,
          promptTokens: u.prompt_tokens,
          completionTokens: u.completion_tokens,
          totalTokens: u.total_tokens ?? undefined,
        })),
      };
    } catch (error) {
      console.warn("[AgentRunLedger] getRun failed:", error);
      return null;
    }
  }

  /** Aggregate token usage + run counts, optionally since a timestamp (ms). */
  summarize(filter?: { sinceMs?: number }): AgentRunSummary {
    const empty: AgentRunSummary = {
      totalRuns: 0, completedRuns: 0, failedRuns: 0, abortedRuns: 0,
      promptTokens: 0, completionTokens: 0, byModel: [],
    };
    try {
      const since = typeof filter?.sinceMs === "number" ? filter.sinceMs : 0;
      const totals = this.db
        .prepare(
          `SELECT COUNT(*) AS total,
             SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
             SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
             SUM(CASE WHEN status = 'aborted' THEN 1 ELSE 0 END) AS aborted,
             COALESCE(SUM(prompt_tokens), 0) AS prompt,
             COALESCE(SUM(completion_tokens), 0) AS completion
           FROM runs WHERE started_at >= ?`,
        )
        .get(since) as { total: number; completed: number; failed: number; aborted: number; prompt: number; completion: number };
      const byModel = this.db
        .prepare(
          `SELECT COALESCE(model, 'unknown') AS model, COUNT(*) AS runs,
             COALESCE(SUM(prompt_tokens), 0) AS prompt,
             COALESCE(SUM(completion_tokens), 0) AS completion
           FROM runs WHERE started_at >= ?
           GROUP BY COALESCE(model, 'unknown') ORDER BY (prompt + completion) DESC`,
        )
        .all(since) as Array<{ model: string; runs: number; prompt: number; completion: number }>;
      return {
        totalRuns: totals.total,
        completedRuns: totals.completed ?? 0,
        failedRuns: totals.failed ?? 0,
        abortedRuns: totals.aborted ?? 0,
        promptTokens: totals.prompt,
        completionTokens: totals.completion,
        byModel: byModel.map((m) => ({
          model: m.model,
          runs: m.runs,
          promptTokens: m.prompt,
          completionTokens: m.completion,
        })),
      };
    } catch (error) {
      console.warn("[AgentRunLedger] summarize failed:", error);
      return empty;
    }
  }

  /** Runs still marked 'running' — used to close out stale rows on startup. */
  markStaleRunsAborted(staleBeforeMs: number): number {
    try {
      const res = this.db
        .prepare(
          `UPDATE runs SET status = 'aborted', ended_at = ?, error = 'process exited before run finished'
           WHERE status = 'running' AND started_at < ?`,
        )
        .run(Date.now(), staleBeforeMs);
      return res.changes;
    } catch (error) {
      console.warn("[AgentRunLedger] markStaleRunsAborted failed:", error);
      return 0;
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // best-effort
    }
  }
}
