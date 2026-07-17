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
 * The SchedulerService keeps a single setInterval tick (per-minute) and calls
 * the supplied runner callback for each due task. It is fully fakeable: pass a
 * clock function + runner in tests instead of using real time.
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

export interface SchedulerRunner {
  (task: ScheduledTaskEntry, fireTime: Date): Promise<void> | void
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
}

export class SchedulerService {
  private readonly opts: Required<SchedulerServiceOptions>
  private timer: ReturnType<typeof setInterval> | null = null
  private lastTickMs = 0
  constructor(opts: SchedulerServiceOptions) {
    this.opts = {
      now: () => new Date(),
      intervalMs: 60_000,
      ...opts,
    } as any
  }
  start(): void {
    if (this.timer) return
    this.lastTickMs = this.opts.now().getTime()
    this.timer = setInterval(() => this.tick(), this.opts.intervalMs)
  }
  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }
  /** Evaluate due tasks between the last tick and now. Exposed for tests. */
  async tick(): Promise<void> {
    const now = this.opts.now()
    const nowMs = now.getTime()
    // Walk minute by minute from lastTick to now so we never skip a firing.
    let cur = new Date(Math.ceil(this.lastTickMs / 60000) * 60000)
    while (cur.getTime() <= nowMs) {
      for (const task of this.opts.getTasks()) {
        if (!task.enabled) continue
        try {
          if (matchesCron(task.cron, cur)) {
            await this.opts.run(task, new Date(cur))
          }
        } catch {
          // A bad task should not crash the scheduler.
        }
      }
      cur = new Date(cur.getTime() + 60000)
    }
    this.lastTickMs = nowMs
  }
}
