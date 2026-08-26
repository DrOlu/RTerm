/**
 * idleTimeout — auto-close idle terminals / archive idle sessions (v3.2.18).
 *
 * An idle SSH tab to a bastion previously held its connection forever. This
 * module tracks last-activity per terminal and decides which ones have been
 * idle past the configured threshold. Pure + injectable: the caller supplies
 * the activity map and the clock.
 *
 * Activity = any write to the terminal (user input or program output). The
 * caller wires TerminalService's data events into `touch()`.
 */

export interface IdleTimeoutOptions {
  /** minutes of inactivity before a terminal is idle. Default 30. */
  idleMinutes?: number
  /** never auto-close these terminal ids (e.g. the bootstrap local shell). */
  protectedIds?: string[]
  /** clock, injectable */
  now?: () => number
}

export interface IdleTerminal {
  terminalId: string
  /** minutes idle */
  idleMinutes: number
}

export class IdleTimeoutService {
  private idleMs: number
  private readonly protectedIds: Set<string>
  private readonly now: () => number
  private readonly lastActivity = new Map<string, number>()

  constructor(opts: IdleTimeoutOptions = {}) {
    this.idleMs = Math.max(0, (opts.idleMinutes ?? 30) * 60_000)
    this.protectedIds = new Set(opts.protectedIds ?? [])
    this.now = opts.now ?? (() => Date.now())
  }

  /** Record activity for a terminal. */
  touch(terminalId: string): void {
    this.lastActivity.set(terminalId, this.now())
  }

  /** Register a terminal (starts its idle clock). */
  register(terminalId: string): void {
    if (!this.lastActivity.has(terminalId)) {
      this.lastActivity.set(terminalId, this.now())
    }
  }

  /** Forget a terminal (on close). */
  forget(terminalId: string): void {
    this.lastActivity.delete(terminalId)
  }

  /** Is this terminal idle past the threshold? */
  isIdle(terminalId: string): boolean {
    if (this.protectedIds.has(terminalId)) return false
    const last = this.lastActivity.get(terminalId)
    if (last === undefined) return false
    return this.now() - last >= this.idleMs
  }

  /** All currently-idle terminals (among the known ones). */
  idleTerminals(knownIds: readonly string[]): IdleTerminal[] {
    const t = this.now()
    const out: IdleTerminal[] = []
    for (const id of knownIds) {
      if (this.protectedIds.has(id)) continue
      const last = this.lastActivity.get(id)
      if (last === undefined) continue
      const idleMin = (t - last) / 60_000
      if (idleMin * 60_000 >= this.idleMs) {
        out.push({ terminalId: id, idleMinutes: Math.round(idleMin * 10) / 10 })
      }
    }
    return out
  }

  /** Configure the threshold at runtime. */
  setIdleMinutes(minutes: number): void {
    this.idleMs = Math.max(0, minutes * 60_000)
  }

  get idleMinutes(): number {
    return this.idleMs / 60_000
  }
}
