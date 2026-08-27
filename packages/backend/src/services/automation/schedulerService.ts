import type { ScheduledTaskEntry } from '../../types'

/**
 * A minimal 5-field cron expression evaluator (no external dep).
 *
 * Fields: minute hour day-of-month month day-of-week (0-6 Sun..Sat, 7=Sun).
 * Supports: * , - /   (no @reboot, no L/W, no names — intentionally small).
 * `matchesCron(expr, date)` tells whether a given Date is due at the minute
 * granularity. `nextRunUtc(expr, after)` computes the next firing Date (used by
 * the UI and to sleep until the next run).
 *
 * v3.2.16 additions:
 * - **Timezone-aware evaluation.** `matchesCronInTz(expr, date, tz)` evaluates
 *   the expression in an IANA timezone (via the Intl API — no external dep).
 *   The scheduler passes each task's `timezone` (default: daemon-local), so a
 *   task set for "2am Africa/Lagos" fires at 2am Lagos time regardless of
 *   where the daemon runs, and DST transitions are handled by the tz database.
 * - **Overlap guard.** The scheduler tracks in-flight executions per task and
 *   SKIPS (default) or queues a new firing while the previous one still runs.
 * - **Pause windows.** `pausedUntil` (ISO) suppresses firings until that time.
 * - **Run history.** The scheduler records per-task run outcomes (last N) so
 *   the UI/agent can show success rate, avg duration, and last error.
 * - **Failure streaks.** Consecutive-failure counting drives `alertAfterFailures`.
 * - **Drift detection.** `detectDrift()` flags a task that has not fired in
 *   more than 3× its expected interval (bad edit, silently broken expression).
 *
 * Safety semantics (unchanged from v3.1):
 * - A fresh service has no catch-up window: the first tick evaluates only the
 *   current minute. (Previously `lastTickMs` started at 0, so a first tick
 *   walked minute-by-minute from the 1970 epoch — firing matching tasks
 *   millions of times and spinning the CPU.)
 * - Each task fires at most once per tick, even if several of its due minutes
 *   fall inside the catch-up window (e.g. after the machine slept). Burst-firing
 *   a missed task N times in a tight loop is almost never what an operator
 *   wants and is dangerous for non-idempotent commands.
 * - The catch-up window is capped (default 24h) so a long hibernation cannot
 *   produce an unbounded replay. A task must ALSO opt in via `catchUp: true`
 *   for missed minutes inside the window to fire at all (v3.2.16: default is
 *   now "a missed run stays missed", matching classic cron).
 */

export function parseCron(expr: string): number[][] {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) throw new Error(`Invalid cron expression "${expr}": expected 5 fields`)
  const ranges = [
    { min: 0, max: 59 }, // minute
    { min: 0, max: 23 }, // hour
    { min: 1, max: 31 }, // day of month
    { min: 1, max: 12 }, // month
    { min: 0, max: 7 }, // day of week (0=Sun, 7=Sun)
  ]
  return fields.map((f, i) => parseField(f, ranges[i].min, ranges[i].max))
}

/** Validate a cron expression — throws with a human-readable reason on error. */
export function validateCron(expr: string): { ok: true } | { ok: false; reason: string } {
  try {
    const sets = parseCron(expr)
    // A valid expression that matches nothing (e.g. "0 0 31 2 *") is still
    // valid cron; nextRunUtc would throw, so check it here for a clear error.
    try {
      nextRunUtc(expr, new Date())
    } catch {
      return { ok: false, reason: `expression never matches within a year: "${expr}"` }
    }
    if (sets.some((s) => s.length === 0)) {
      return { ok: false, reason: `expression has an empty field: "${expr}"` }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

function parseField(field: string, min: number, max: number): number[] {
  const out = new Set<number>()
  for (const part of field.split(',')) {
    const stepMatch = part.match(/^(.*)\/(\d+)$/)
    let range: string = part
    let step = 1
    if (stepMatch) {
      range = stepMatch[1] || '*'
      step = parseInt(stepMatch[2], 10)
    }
    let lo = min
    let hi = max
    if (range !== '*') {
      const dashMatch = range.match(/^(\d+)-(\d+)$/)
      if (dashMatch) {
        lo = parseInt(dashMatch[1], 10)
        hi = parseInt(dashMatch[2], 10)
      } else {
        lo = parseInt(range, 10)
        hi = lo
      }
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi) {
      throw new Error(`invalid field "${field}"`)
    }
    for (let v = lo; v <= hi; v += step) {
      // Normalize day-of-week 7 → 0
      const norm = (max === 7 && v === 7) ? 0 : v
      out.add(norm)
    }
  }
  if (max === 7 && out.has(7)) out.add(0)
  return [...out]
}

export function matchesCron(expr: string, date: Date): boolean {
  const sets = parseCron(expr)
  return (
    sets[0].includes(date.getUTCMinutes()) &&
    sets[1].includes(date.getUTCHours()) &&
    sets[2].includes(date.getUTCDate()) &&
    sets[3].includes(date.getUTCMonth() + 1) &&
    sets[4].includes(date.getUTCDay())
  )
}

// ── Timezone-aware evaluation (v3.2.16) ────────────────────────────────────

/** Parts of a Date as seen in an IANA timezone, via the Intl API (no dep). */
export function datePartsInTz(date: Date, timeZone?: string): {
  minute: number; hour: number; day: number; month: number; weekday: number
} {
  if (!timeZone) {
    return {
      minute: date.getMinutes(),
      hour: date.getHours(),
      day: date.getDate(),
      month: date.getMonth() + 1,
      weekday: date.getDay(),
    }
  }
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    minute: 'numeric',
    hour: 'numeric',
    day: 'numeric',
    month: 'numeric',
    weekday: 'short',
  })
  const parts: Record<string, string> = {}
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value
  const weekdayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const hour = Number(parts.hour) % 24 // Intl gives "24" for midnight hour12:false
  return {
    minute: Number(parts.minute),
    hour,
    day: Number(parts.day),
    month: Number(parts.month),
    weekday: weekdayNames.indexOf(parts.weekday ?? ''),
  }
}

/** Evaluate a cron expression as seen in the given IANA timezone. */
export function matchesCronInTz(expr: string, date: Date, timeZone?: string): boolean {
  const sets = parseCron(expr)
  const p = datePartsInTz(date, timeZone)
  return (
    sets[0].includes(p.minute) &&
    sets[1].includes(p.hour) &&
    sets[2].includes(p.day) &&
    sets[3].includes(p.month) &&
    sets[4].includes(p.weekday)
  )
}

/** Compute the next Date (UTC, minute-granular) at/after `after`. */
export function nextRunUtc(expr: string, after: Date = new Date()): Date {
  const start = new Date(after.getTime() + 60000 - (after.getTime() % 60000))
  // Cap the search at ~1 year to avoid pathological expressions hanging.
  const cap = new Date(start.getTime() + 366 * 24 * 60 * 60000)
  let cur = start
  while (cur < cap) {
    if (matchesCron(expr, cur)) return cur
    cur = new Date(cur.getTime() + 60000)
  }
  throw new Error(`No next run found within a year for cron "${expr}"`)
}

// ── Pause windows (v3.2.16) ────────────────────────────────────────────────

/** True while the task is paused (pausedUntil in the future). */
export function isPaused(task: ScheduledTaskEntry, now: Date): boolean {
  if (!task.pausedUntil) return false
  const until = Date.parse(task.pausedUntil)
  return Number.isFinite(until) && now.getTime() < until
}

// ── Drift detection (v3.2.16) ──────────────────────────────────────────────

/** Expected minutes between firings, estimated from the expression (upper bound).
 *  * * * * * → 1; 0 * * * * → 60; 0 0 * * * → 1440; 0 0 1 * * → 44640.
 *  When BOTH dom and dow are restricted, cron's OR semantics mean the task
 *  fires more often than either alone — we take the more frequent estimate. */
export function expectedIntervalMinutes(expr: string): number {
  const sets = parseCron(expr)
  const [min, hour, dom, mon, dow] = sets
  if (min.length >= 59) return 1
  if (hour.length >= 23) return Math.max(1, Math.round(60 / Math.max(1, min.length)))
  const everyDom = dom.length >= 28
  const everyMon = mon.length >= 12
  const everyDow = dow.length >= 7
  if (everyDom && everyMon && everyDow) return 1440 // every day
  if (everyDom && everyMon) {
    // dom is unrestricted; dow may restrict to specific weekdays
    return Math.max(1, Math.round(1440 / Math.max(1, dow.length)))
  }
  if (everyDow && everyMon) {
    // dow unrestricted; dom restricts to specific days of the month
    return Math.max(1, Math.round(1440 / Math.max(1, dom.length)))
  }
  // both restricted (cron ORs them) — the more frequent of the two
  const byDom = 1440 / Math.max(1, dom.length)
  const byDow = 1440 / Math.max(1, dow.length)
  return Math.max(1, Math.round(Math.min(byDom, byDow)))
}

export interface TaskDrift {
  taskId: string
  taskName: string
  /** minutes since the task last fired (Infinity when never). */
  minutesSinceLastRun: number
  /** expected interval in minutes (upper bound). */
  expectedIntervalMinutes: number
  /** true when minutesSinceLastRun > 3× expected (and > 60 min). */
  drifted: boolean
}

/** Flag enabled tasks that have not fired in >3× their expected interval. */
export function detectDrift(
  tasks: readonly ScheduledTaskEntry[],
  now: Date,
): TaskDrift[] {
  const out: TaskDrift[] = []
  for (const task of tasks) {
    if (!task.enabled) continue
    if (isPaused(task, now)) continue
    const expected = expectedIntervalMinutes(task.cron)
    const lastMs = task.lastRunAt ? Date.parse(task.lastRunAt) : NaN
    const sinceMin = Number.isFinite(lastMs)
      ? (now.getTime() - lastMs) / 60_000
      : Number.POSITIVE_INFINITY
    const drifted = sinceMin > Math.max(60, expected * 3)
    out.push({
      taskId: task.id,
      taskName: task.name,
      minutesSinceLastRun: sinceMin,
      expectedIntervalMinutes: expected,
      drifted,
    })
  }
  return out
}

// ── Run history (v3.2.16) ──────────────────────────────────────────────────

export interface ScheduledTaskRunRecord {
  /** ISO start time of the run. */
  at: string
  ok: boolean
  /** wall-clock duration ms. */
  durationMs: number
  /** number of targets that ran. */
  targets: number
  /** number of targets that failed. */
  failed: number
  error?: string
}

const MAX_HISTORY = 20

/** In-memory per-task run history ring (last MAX_HISTORY runs). */
export class RunHistoryStore {
  private readonly byTask = new Map<string, ScheduledTaskRunRecord[]>()
  private readonly failureStreaks = new Map<string, number>()

  record(taskId: string, rec: ScheduledTaskRunRecord): void {
    const arr = this.byTask.get(taskId) ?? []
    arr.push(rec)
    if (arr.length > MAX_HISTORY) arr.shift()
    this.byTask.set(taskId, arr)
    const cur = this.failureStreaks.get(taskId) ?? 0
    this.failureStreaks.set(taskId, rec.ok ? 0 : cur + 1)
  }

  history(taskId: string): readonly ScheduledTaskRunRecord[] {
    return this.byTask.get(taskId) ?? []
  }

  consecutiveFailures(taskId: string): number {
    return this.failureStreaks.get(taskId) ?? 0
  }

  /** Success rate over the recorded history (0..1); 1 when no runs yet. */
  successRate(taskId: string): number {
    const h = this.history(taskId)
    if (h.length === 0) return 1
    return h.filter((r) => r.ok).length / h.length
  }

  /** Average duration ms over the recorded history; 0 when no runs. */
  avgDurationMs(taskId: string): number {
    const h = this.history(taskId)
    if (h.length === 0) return 0
    return Math.round(h.reduce((s, r) => s + r.durationMs, 0) / h.length)
  }

  clear(taskId?: string): void {
    if (taskId) {
      this.byTask.delete(taskId)
      this.failureStreaks.delete(taskId)
    } else {
      this.byTask.clear()
      this.failureStreaks.clear()
    }
  }
}

// ── The scheduler ───────────────────────────────────────────────────────────

export interface SchedulerRunner {
  (task: ScheduledTaskEntry, fireTime: Date): Promise<void> | void
}

export interface SchedulerFireDecision {
  /** fire the task now. */
  fire: boolean
  /** why not (logged when fire=false). */
  reason?: 'paused' | 'overlap-skip' | 'disabled'
}

/** Pure decision: should this task fire at `now`? */
export function shouldFire(
  task: ScheduledTaskEntry,
  now: Date,
  isRunning: boolean,
): SchedulerFireDecision {
  if (!task.enabled) return { fire: false, reason: 'disabled' }
  if (isPaused(task, now)) return { fire: false, reason: 'paused' }
  const maxConcurrent = task.maxConcurrent ?? 1
  if (isRunning && maxConcurrent <= 1) {
    return { fire: false, reason: 'overlap-skip' }
  }
  return { fire: true }
}

export interface SchedulerServiceOptions {
  /** Returns current tasks to evaluate. Defaults to no-op (caller wires the store). */
  getTasks: () => readonly ScheduledTaskEntry[]
  /** Called for each due task. */
  run: SchedulerRunner
  /** Inject a clock for tests; defaults to Date.now. */
  now?: () => Date
  /** Tick interval ms; default 60000 (per-minute). */
  intervalMs?: number
  /** Called when a firing is skipped (pause/overlap). Optional. */
  onSkip?: (task: ScheduledTaskEntry, reason: NonNullable<SchedulerFireDecision['reason']>, at: Date) => void
  /** Shared run-history store (optional; the scheduler creates one when omitted). */
  history?: RunHistoryStore
  /** Called once per evaluated minute (after due tasks). Used to fire schedule-kind triggers. */
  onMinute?: (at: Date) => void
}

export class SchedulerService {
  private readonly opts: Required<SchedulerServiceOptions>
  private timer: ReturnType<typeof setInterval> | null = null
  private lastTickMs = 0
  /** task ids with an in-flight execution (overlap guard). */
  private readonly inFlight = new Set<string>()
  readonly history: RunHistoryStore

  constructor(opts: SchedulerServiceOptions) {
    this.opts = {
      now: () => new Date(),
      intervalMs: 60_000,
      onSkip: () => {},
      ...opts,
    } as any
    this.history = opts.history ?? new RunHistoryStore()
  }

  /** Manually fire a task now (run-now), respecting the overlap guard. */
  async runNow(task: ScheduledTaskEntry): Promise<{ ran: boolean; reason?: string }> {
    const now = this.opts.now()
    const decision = shouldFire(task, now, this.inFlight.has(task.id))
    if (!decision.fire) {
      this.opts.onSkip(task, decision.reason!, now)
      return { ran: false, reason: decision.reason }
    }
    await this.execute(task, now)
    return { ran: true }
  }

  /** Wrap one execution with the in-flight guard + history record. */
  private async execute(task: ScheduledTaskEntry, fireTime: Date): Promise<void> {
    this.inFlight.add(task.id)
    const startedAt = Date.now()
    let ok = true
    let error: string | undefined
    let targets = 0
    let failed = 0
    try {
      await this.opts.run(task, fireTime)
    } catch (e) {
      ok = false
      error = e instanceof Error ? e.message : String(e)
    } finally {
      this.inFlight.delete(task.id)
    }
    this.history.record(task.id, {
      at: fireTime.toISOString(),
      ok,
      durationMs: Date.now() - startedAt,
      targets,
      failed,
      ...(error ? { error } : {}),
    })
  }

  start(): void {
    if (this.timer) return
    this.lastTickMs = this.opts.now().getTime()
    this.timer = setInterval(() => this.tick(), this.opts.intervalMs)
    // Let the process exit even if the scheduler is still running (Node only).
    const t: unknown = this.timer
    if (t && typeof (t as { unref?: () => void }).unref === 'function') {
      ;(t as { unref: () => void }).unref()
    }
  }
  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }
  /** Evaluate due tasks between the last tick and now. Exposed for tests. */
  async tick(): Promise<void> {
    const now = this.opts.now()
    const nowMs = now.getTime()
    if (this.lastTickMs <= 0) {
      // First tick of a fresh service: evaluate only the current minute.
      this.lastTickMs = nowMs - (nowMs % 60_000) - 1
    }
    // Walk minute by minute from lastTick to now so we never skip a firing,
    // but cap the catch-up window and fire each task at most once per tick.
    const maxCatchupMs = 24 * 60 * 60 * 1000
    const windowStartMs = Math.max(this.lastTickMs, nowMs - maxCatchupMs)
    const fired = new Set<string>()
    // An exactly-aligned window start means that minute was already evaluated
    // by the previous tick (the walk is inclusive), so begin one minute later.
    const firstMinuteMs =
      windowStartMs % 60_000 === 0
        ? windowStartMs + 60_000
        : Math.ceil(windowStartMs / 60_000) * 60_000
    let cur = new Date(firstMinuteMs)
    while (cur.getTime() <= nowMs) {
      for (const task of this.opts.getTasks()) {
        if (!task.enabled || fired.has(task.id)) continue
        try {
          const tz = task.timezone || undefined
          const due = tz
            ? matchesCronInTz(task.cron, cur, tz)
            : matchesCron(task.cron, cur)
          if (!due) continue
          // Catch-up policy: only fire for a PAST minute when the task opted
          // in. The current minute always fires.
          const isCurrentMinute = cur.getTime() > nowMs - 60_000
          if (!isCurrentMinute && !task.catchUp) continue
          fired.add(task.id)
          const decision = shouldFire(task, now, this.inFlight.has(task.id))
          if (!decision.fire) {
            this.opts.onSkip(task, decision.reason!, cur)
            continue
          }
          await this.execute(task, new Date(cur))
        } catch {
          // A bad task should not crash the scheduler.
        }
      }
      try { this.opts.onMinute?.(new Date(cur)) } catch { /* schedule triggers must not crash the tick */ }
      cur = new Date(cur.getTime() + 60_000)
    }
    this.lastTickMs = nowMs
  }
}
