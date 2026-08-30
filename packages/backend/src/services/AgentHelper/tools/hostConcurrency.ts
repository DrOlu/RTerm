/**
 * hostConcurrency — per-host concurrency caps + a fair work queue.
 *
 * THE PROBLEM (found by auditing the execution loop):
 *   run_fleet_command() fans out with bare Promise.allSettled over up to 25
 *   targets. There is no per-host cap and no global cap, so a fleet command
 *   over N tabs opens N simultaneous SSH/WinRM channels. Against one box
 *   that is N concurrent shells — most servers refuse (MaxStartups on sshd
 *   defaults to 10:30:100), and even when they accept it, the box starves.
 *   Meanwhile a second agent run trying to use the same host has to fight
 *   the first one for the same channels.
 *
 * THE FIX (v3.4.2, rewritten after the first draft deadlocked):
 *   - A keyed semaphore: at most N concurrent operations per HOST (default 3),
 *     regardless of how many tabs or agent runs target it.
 *   - A global cap (default 12) so a 25-target fleet cannot open 25 channels
 *     at once even across distinct hosts.
 *   - FIFO fairness inside each host bucket — no starvation, and no
 *     queue-jumping: the fast path is disabled while anyone is queued.
 *   - Queue depth + per-op wait time are observable, so the agent can be
 *     told it is waiting rather than appearing hung.
 *   - Queued ops honour an AbortSignal (a cancelled fleet run must not keep
 *     holding queue slots).
 *
 * CORRECTNESS NOTES (bugs the first draft had — do not regress):
 *   1. A queued waiter is granted its slot BY pump(), which already
 *      increments the counters. The waiter must NOT acquire again on wake —
 *      double-acquire inflates running counts past the cap and permanently
 *      saturates the host (every later op queues forever = deadlock).
 *   2. The global-FIFO pass must respect per-host caps too, otherwise a
 *      host over its limit gets more concurrent ops than allowed.
 *   3. A timeout must not fight a grant: whichever settles the waiter
 *      first wins; the loser is a no-op, and the timer is cleared on grant
 *      so it cannot fire late and reject an op that is already running.
 *   4. Counters are reconciled on release (never below zero) so a bug
 *      elsewhere degrades to "slightly wrong cap", never a permanent stall.
 */

/** Resolve a stable host key from a terminal tab + its connection config. */
export function hostKeyForTab(
  tab: { id: string; type?: string },
  config?: { host?: string; address?: string; path?: string; type?: string } | null,
): string {
  const cfg = config ?? {}
  const host = cfg.host ?? cfg.address
  if (host && String(host).trim()) return String(host).trim().toLowerCase()
  if (cfg.path && String(cfg.path).trim()) return `serial:${String(cfg.path).trim()}`
  const type = (cfg?.type ?? tab.type ?? '').toLowerCase()
  if (type === 'local') return 'local'
  return `tab:${tab.id}`
}

interface Waiter {
  resolve: () => void
  reject: (err: Error) => void
  /** For diagnostics: what is queued. */
  label: string
  enqueuedAt: number
  /** Guards double-settle (grant vs timeout vs abort). */
  settled: boolean
  timer: NodeJS.Timeout | null
  /** Abort listener for signal-aware queueing. */
  onAbort: (() => void) | null
  signal: AbortSignal | null
}

export interface HostConcurrencyStats {
  host: string
  running: number
  queued: number
  limit: number
}

export interface HostConcurrencyOptions {
  /** Max concurrent operations against one host. Default 3. */
  perHost?: number
  /** Max concurrent operations across ALL hosts. Default 12. */
  global?: number
  /** Max ms a queued op waits before failing (0 = wait forever). Default 0. */
  queueTimeoutMs?: number
}

export interface HostRunOptions {
  /** Abort while queued (or before start) — the op never runs. */
  signal?: AbortSignal
  /** Called with the ms spent waiting in queue (0 = ran immediately). */
  onWaitedMs?: (waitedMs: number) => void
}

export class HostConcurrency {
  private readonly perHost: number
  private readonly global: number
  private readonly queueTimeoutMs: number

  private runningByHost = new Map<string, number>()
  private queueByHost = new Map<string, Waiter[]>()
  private globalRunning = 0
  private globalQueue: Waiter[] = []
  private seq = 0

  constructor(options?: HostConcurrencyOptions) {
    this.perHost = Math.max(1, options?.perHost ?? 3)
    this.global = Math.max(1, options?.global ?? 12)
    this.queueTimeoutMs = options?.queueTimeoutMs ?? 0
  }

  /** Run `fn` under the host cap. FIFO per host; global cap across hosts. */
  async run<T>(
    host: string,
    fn: () => Promise<T>,
    label = '',
    options?: HostRunOptions,
  ): Promise<T> {
    const key = String(host || 'unknown').toLowerCase()
    const id = ++this.seq
    const desc = label || `op#${id}`
    const waitedFrom = Date.now()

    // Fast path: both caps have room AND nobody is queued ahead of us
    // (queue-jumping here would starve the FIFO waiters).
    if (this.canStart(key) && !this.hasQueuedWaiters()) {
      // v3.4.3: an already-aborted op must not consume a slot or start fn —
      // the fast path previously skipped the abort check entirely, so a
      // cancelled fleet run still fired N commands at the host.
      if (options?.signal?.aborted) {
        const err = new Error('Aborted before acquiring a host slot')
        err.name = 'AbortError'
        return Promise.reject(err)
      }
      this.acquire(key)
      this.notifyWaited(waitedFrom, options)
      try {
        return await fn()
      } finally {
        this.release(key)
      }
    }

    // Queue: per-host FIFO, plus a global waiter list for the global cap.
    await this.waitForSlot(key, desc, options)
    // pump() already incremented the counters when it granted this slot —
    // acquiring again here would double-count and deadlock the host.
    this.notifyWaited(waitedFrom, options)
    try {
      return await fn()
    } finally {
      this.release(key)
    }
  }

  private notifyWaited(from: number, options?: HostRunOptions): void {
    if (options?.onWaitedMs) {
      try {
        options.onWaitedMs(Date.now() - from)
      } catch {
        /* diagnostics must never break execution */
      }
    }
  }

  private hasQueuedWaiters(): boolean {
    if (this.globalQueue.length > 0) return true
    for (const q of this.queueByHost.values()) {
      if (q.length > 0) return true
    }
    return false
  }

  private canStart(host: string): boolean {
    return (
      (this.runningByHost.get(host) ?? 0) < this.perHost &&
      this.globalRunning < this.global
    )
  }

  private acquire(host: string): void {
    this.runningByHost.set(host, (this.runningByHost.get(host) ?? 0) + 1)
    this.globalRunning += 1
  }

  private release(host: string): void {
    const n = (this.runningByHost.get(host) ?? 1) - 1
    if (n <= 0) this.runningByHost.delete(host)
    else this.runningByHost.set(host, n)
    this.globalRunning = Math.max(0, this.globalRunning - 1)
    this.pump()
  }

  private waitForSlot(host: string, label: string, options?: HostRunOptions): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        label,
        enqueuedAt: Date.now(),
        settled: false,
        timer: null,
        onAbort: null,
        signal: options?.signal ?? null,
      }

      const settle = (err?: Error) => {
        if (waiter.settled) return
        waiter.settled = true
        if (waiter.timer) {
          clearTimeout(waiter.timer)
          waiter.timer = null
        }
        if (waiter.signal && waiter.onAbort) {
          waiter.signal.removeEventListener('abort', waiter.onAbort)
          waiter.onAbort = null
        }
        // Remove from both queues (idempotent — grant path also removes).
        this.removeWaiter(host, waiter)
        if (err) reject(err)
        else resolve()
      }

      waiter.onAbort = () => {
        // v3.4.3: name the error AbortError so isAbortError() recognises it.
        // The old plain Error('Aborted while waiting for a host slot') was
        // treated as a per-target FAILURE by runOnOneTab/collectFacts, so a
        // user-cancelled fleet run reported N bogus FAIL rows (and the abort
        // never propagated to stop the fan-out) instead of one clean abort.
        const err = new Error('Aborted while waiting for a host slot')
        err.name = 'AbortError'
        settle(err)
      }

      const q = this.queueByHost.get(host) ?? []
      q.push(waiter)
      this.queueByHost.set(host, q)
      this.globalQueue.push(waiter)

      if (waiter.signal) {
        if (waiter.signal.aborted) {
          waiter.onAbort()
          return
        }
        waiter.signal.addEventListener('abort', waiter.onAbort, { once: true })
      }

      if (this.queueTimeoutMs > 0) {
        const t = setTimeout(() => {
          settle(new Error(`host queue timeout after ${this.queueTimeoutMs}ms waiting for ${host}`))
        }, this.queueTimeoutMs)
        // do not hold the loop open for the timeout
        if (typeof t.unref === 'function') t.unref()
        waiter.timer = t
      }
    })
  }

  private removeWaiter(host: string, waiter: Waiter): void {
    const q = this.queueByHost.get(host)
    if (q) {
      const i = q.indexOf(waiter)
      if (i >= 0) q.splice(i, 1)
      if (q.length === 0) this.queueByHost.delete(host)
    }
    const gi = this.globalQueue.indexOf(waiter)
    if (gi >= 0) this.globalQueue.splice(gi, 1)
  }

  /** Grant slots to queued waiters, per-host FIFO first, then global FIFO. */
  private pump(): void {
    // Per-host first: a host with free capacity should not be blocked by
    // the global queue head pointing at a saturated host.
    for (const [host, q] of Array.from(this.queueByHost.entries())) {
      while (
        q.length > 0 &&
        (this.runningByHost.get(host) ?? 0) < this.perHost &&
        this.globalRunning < this.global
      ) {
        const w = q.shift()!
        if (q.length === 0) this.queueByHost.delete(host)
        const gi = this.globalQueue.indexOf(w)
        if (gi >= 0) this.globalQueue.splice(gi, 1)
        this.runningByHost.set(host, (this.runningByHost.get(host) ?? 0) + 1)
        this.globalRunning += 1
        this.settleWaiter(w)
      }
    }
    // Then global FIFO for anything left — but NEVER exceed a host's own cap.
    while (this.globalQueue.length > 0 && this.globalRunning < this.global) {
      const w = this.globalQueue[0]
      const host = this.findWaiterHost(w)
      if (!host) {
        // Waiter not in any host queue (already timed out / aborted) — drop it.
        this.globalQueue.shift()
        continue
      }
      if ((this.runningByHost.get(host) ?? 0) >= this.perHost) {
        // Head of the global queue is for a saturated host; do not grant
        // behind it (would violate the per-host cap). The per-host pass
        // already ran; remaining waiters need a host slot to free up.
        break
      }
      this.globalQueue.shift()
      const q = this.queueByHost.get(host)
      if (q) {
        const i = q.indexOf(w)
        if (i >= 0) q.splice(i, 1)
        if (q.length === 0) this.queueByHost.delete(host)
      }
      this.runningByHost.set(host, (this.runningByHost.get(host) ?? 0) + 1)
      this.globalRunning += 1
      this.settleWaiter(w)
    }
  }

  private findWaiterHost(w: Waiter): string | null {
    for (const [host, q] of this.queueByHost.entries()) {
      if (q.includes(w)) return host
    }
    return null
  }

  /** Grant path: mark settled and resolve. The waiting run() continuation
   *  executes fn and releases in its finally. */
  private settleWaiter(waiter: Waiter): void {
    if (waiter.settled) return
    waiter.settled = true
    if (waiter.timer) {
      clearTimeout(waiter.timer)
      waiter.timer = null
    }
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort)
      waiter.onAbort = null
    }
    waiter.resolve()
  }

  /** Observable state — surfaced to the agent so a wait is not a mystery. */
  stats(): HostConcurrencyStats[] {
    const out: HostConcurrencyStats[] = []
    const hosts = new Set<string>([
      ...this.runningByHost.keys(),
      ...this.queueByHost.keys(),
    ])
    for (const host of hosts) {
      out.push({
        host,
        running: this.runningByHost.get(host) ?? 0,
        queued: (this.queueByHost.get(host) ?? []).length,
        limit: this.perHost,
      })
    }
    return out
  }

  get globalRunningCount(): number {
    return this.globalRunning
  }

  get globalQueuedCount(): number {
    return this.globalQueue.length
  }
}

/** Process-wide default instance (per-host 3, global 12). */
let defaultInstance: HostConcurrency | null = null

export function getDefaultHostConcurrency(): HostConcurrency {
  if (!defaultInstance) {
    defaultInstance = new HostConcurrency()
  }
  return defaultInstance
}

/** Test hook: replace/reset the process-wide instance. */
export function setDefaultHostConcurrency(instance: HostConcurrency | null): void {
  defaultInstance = instance
}
