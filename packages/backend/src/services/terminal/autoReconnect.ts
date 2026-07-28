/**
 * autoReconnect — schedules terminal reconnection with exponential backoff +
 * jitter when a session drops unexpectedly. Pure + injectable: the actual
 * reconnect + state-notification functions are injected; this module only owns
 * the backoff math and the timer bookkeeping (deterministic `now` for tests).
 *
 * One instance per TerminalService. Each terminal gets an independent backoff
 * schedule; manual kills / user-initiated reconnects cancel the schedule.
 */

export interface AutoReconnectOptions {
  /** base delay in ms (default 1000). */
  baseDelayMs?: number
  /** max delay cap in ms (default 60000). */
  maxDelayMs?: number
  /** max attempts before giving up (default Infinity). */
  maxAttempts?: number
  /** jitter fraction 0..1 applied to each delay (default 0.2 = ±20%). */
  jitterRatio?: number
  /** injectable now (default Date.now) — tests pass a fake clock. */
  now?: () => number
  /** injectable jitter source 0..1 (default Math.random) — tests pass a fixed value. */
  random?: () => number
  /** injectable setTimeout (default global setTimeout). */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown
  /** injectable clearTimeout (default global clearTimeout). */
  clearTimeoutFn?: (handle: unknown) => void
}

export interface ReconnectScheduleState {
  terminalId: string
  /** attempt number that will fire next (1-based). */
  nextAttempt: number
  /** the delay (ms) that was used for the pending/next attempt. */
  nextDelayMs: number
  /** total attempts fired so far. */
  attemptsFired: number
  /** whether the schedule is still active (not cancelled / not exhausted). */
  active: boolean
}

const DEFAULT_BASE = 1000
const DEFAULT_MAX = 60000
const DEFAULT_JITTER = 0.2

export class AutoReconnect {
  private readonly baseDelayMs: number
  private readonly maxDelayMs: number
  private readonly maxAttempts: number
  private readonly jitterRatio: number
  private readonly random: () => number
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown
  private readonly clearTimeoutFn: (handle: unknown) => void

  /** terminalId → pending timer handle. */
  private readonly timers = new Map<string, unknown>()
  /** terminalId → attempts fired so far. */
  private readonly attempts = new Map<string, number>()
  /** terminalId → delay used for the pending attempt. */
  private readonly pendingDelay = new Map<string, number>()

  constructor(opts: AutoReconnectOptions = {}) {
    this.baseDelayMs = Math.max(1, opts.baseDelayMs ?? DEFAULT_BASE)
    this.maxDelayMs = Math.max(this.baseDelayMs, opts.maxDelayMs ?? DEFAULT_MAX)
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? Number.POSITIVE_INFINITY)
    this.jitterRatio = Math.min(1, Math.max(0, opts.jitterRatio ?? DEFAULT_JITTER))
    this.random = opts.random ?? (() => Math.random())
    this.setTimeoutFn = opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimeoutFn =
      opts.clearTimeoutFn ?? ((h) => clearTimeout(h as Parameters<typeof clearTimeout>[0]))
  }

  /** Compute the delay for attempt N (1-based): base * 2^(n-1), capped, ±jitter. */
  delayForAttempt(attempt: number): number {
    const expo = this.baseDelayMs * Math.pow(2, Math.max(0, attempt - 1))
    const capped = Math.min(this.maxDelayMs, expo)
    const jitter = capped * this.jitterRatio * (this.random() * 2 - 1)
    return Math.max(1, Math.round(capped + jitter))
  }

  /** Whether a schedule is pending for this terminal. */
  isScheduled(terminalId: string): boolean {
    return this.timers.has(terminalId)
  }

  /** Attempts fired so far for this terminal. */
  attemptsFor(terminalId: string): number {
    return this.attempts.get(terminalId) ?? 0
  }

  /** Snapshot the schedule state for a terminal (undefined if not scheduled). */
  state(terminalId: string): ReconnectScheduleState | undefined {
    if (!this.timers.has(terminalId)) return undefined
    const fired = this.attempts.get(terminalId) ?? 0
    return {
      terminalId,
      nextAttempt: fired + 1,
      nextDelayMs: this.pendingDelay.get(terminalId) ?? 0,
      attemptsFired: fired,
      active: true,
    }
  }

  /**
   * Schedule the next reconnect attempt for a terminal. `onAttempt` is called
   * when the timer fires (it should perform the reconnect); `onGiveUp` is
   * called when maxAttempts is reached. Returns the schedule state, or
   * undefined if attempts are already exhausted.
   */
  schedule(
    terminalId: string,
    onAttempt: (attempt: number) => void,
    onGiveUp?: (attempts: number) => void,
  ): ReconnectScheduleState | undefined {
    this.cancel(terminalId)
    const fired = this.attempts.get(terminalId) ?? 0
    const nextAttempt = fired + 1
    if (nextAttempt > this.maxAttempts) {
      onGiveUp?.(fired)
      return undefined
    }
    const delay = this.delayForAttempt(nextAttempt)
    this.pendingDelay.set(terminalId, delay)
    const handle = this.setTimeoutFn(() => {
      this.timers.delete(terminalId)
      this.pendingDelay.delete(terminalId)
      const now = (this.attempts.get(terminalId) ?? 0) + 1
      this.attempts.set(terminalId, now)
      onAttempt(now)
    }, delay)
    this.timers.set(terminalId, handle)
    return {
      terminalId,
      nextAttempt,
      nextDelayMs: delay,
      attemptsFired: fired,
      active: true,
    }
  }

  /** Cancel a pending schedule (does NOT reset the attempt counter). */
  cancel(terminalId: string): boolean {
    const handle = this.timers.get(terminalId)
    if (handle !== undefined) {
      this.clearTimeoutFn(handle)
      this.timers.delete(terminalId)
    }
    this.pendingDelay.delete(terminalId)
    return handle !== undefined
  }

  /** Reset a terminal's attempt counter (call after a successful reconnect). */
  reset(terminalId: string): void {
    this.attempts.delete(terminalId)
    this.pendingDelay.delete(terminalId)
  }

  /** Cancel + reset (call on manual kill / user reconnect / tab close). */
  clear(terminalId: string): void {
    this.cancel(terminalId)
    this.reset(terminalId)
  }

  /** Cancel every pending schedule (shutdown). */
  clearAll(): void {
    for (const id of Array.from(this.timers.keys())) this.cancel(id)
    this.attempts.clear()
    this.pendingDelay.clear()
  }
}
