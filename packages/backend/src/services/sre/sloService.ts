import { randomUUID } from 'crypto'

/**
 * SloService — SLO/SLI definitions, SLI computation, error budgets, and
 * burn-rate alerting (Tier 1 SRE).
 *
 * An SLO declares a target (e.g. 99.9% of good events over a rolling window) and
 * a way to count good vs total events (an injected SLI source). The service
 * computes the current SLI, the remaining error budget, and the burn rate
 * (actual error rate vs. allowed rate), and flags when the budget is being
 * consumed too fast. Pure + injectable: the SLI source is a function that
 * returns {good, total} for a window; storage of SLO defs is in-memory (persist
 * via the automation store).
 */

export interface SloDefinition {
  id: string
  name: string
  /** target fraction of good events, e.g. 0.999 for 99.9%. */
  target: number
  /** rolling window for SLI evaluation in ms (e.g. 30d). */
  windowMs: number
  /** optional fast-burn alert threshold: burn rate above this alerts (default 2). */
  fastBurnThreshold?: number
  createdAt: number
}

export interface SloEvaluation {
  sloId: string
  /** computed SLI (good/total) for the window, 0..1, or undefined when total=0. */
  sli?: number
  /** total events in window. */
  total: number
  good: number
  /** remaining error budget as a fraction of the allowed budget, 0..1 (1 = full). */
  errorBudgetRemaining?: number
  /** burn rate = actual error rate / allowed error rate. >1 = burning too fast. */
  burnRate?: number
  /** true when burnRate exceeds fastBurnThreshold. */
  fastBurning: boolean
  at: number
}

export interface SloSource {
  /** returns {good, total} events for the named SLO in [sinceMs, now]. */
  count: (sloId: string, sinceMs: number, now: number) => Promise<{ good: number; total: number }>
}

export interface SloServiceDeps {
  source: SloSource
  now?: () => number
}

const DEFAULT_FAST_BURN = 2

export class SloService {
  private readonly slos = new Map<string, SloDefinition>()
  private readonly now: () => number

  constructor(private readonly deps: SloServiceDeps) {
    this.now = deps.now ?? (() => Date.now())
  }

  upsert(def: Omit<SloDefinition, 'id' | 'createdAt'> & { id?: string }): SloDefinition {
    const existing = def.id ? this.slos.get(def.id) : Array.from(this.slos.values()).find((s) => s.name === def.name)
    if (existing) {
      const merged: SloDefinition = { ...existing, ...def, id: existing.id, createdAt: existing.createdAt }
      this.slos.set(existing.id, merged)
      return merged
    }
    if (!(def.target > 0 && def.target < 1)) {
      throw new Error('SLO target must be a fraction between 0 and 1 (e.g. 0.999 for 99.9%)')
    }
    if (!(def.windowMs > 0)) {
      throw new Error('SLO windowMs must be positive')
    }
    const entry: SloDefinition = {
      ...def,
      id: def.id ?? `slo-${randomUUID().slice(0, 8)}`,
      createdAt: this.now(),
    }
    this.slos.set(entry.id, entry)
    return entry
  }

  remove(idOrName: string): boolean {
    const needle = idOrName.trim().toLowerCase()
    const t = this.slos.get(idOrName) ?? Array.from(this.slos.values()).find((s) => s.name.trim().toLowerCase() === needle)
    return t ? this.slos.delete(t.id) : false
  }

  list(): readonly SloDefinition[] {
    return Array.from(this.slos.values())
  }

  get(idOrName: string): SloDefinition | undefined {
    const needle = idOrName.trim().toLowerCase()
    return this.slos.get(idOrName) ?? Array.from(this.slos.values()).find((s) => s.name.trim().toLowerCase() === needle)
  }

  /** Evaluate one SLO against its source for the rolling window. */
  async evaluate(idOrName: string): Promise<SloEvaluation> {
    const slo = this.get(idOrName)
    if (!slo) throw new Error(`no SLO "${idOrName}"`)
    const now = this.now()
    const since = now - slo.windowMs
    const { good, total } = await this.deps.source.count(slo.id, since, now)

    const allowedError = 1 - slo.target
    let sli: number | undefined
    let errorBudgetRemaining: number | undefined
    let burnRate: number | undefined

    if (total > 0) {
      sli = good / total
      const actualError = 1 - sli
      if (allowedError > 0) {
        burnRate = actualError / allowedError
        errorBudgetRemaining = Math.max(0, 1 - burnRate)
      }
    }

    const threshold = slo.fastBurnThreshold ?? DEFAULT_FAST_BURN
    return {
      sloId: slo.id,
      sli,
      total,
      good,
      errorBudgetRemaining,
      burnRate,
      fastBurning: burnRate !== undefined && burnRate > threshold,
      at: now,
    }
  }

  /** Evaluate all defined SLOs. */
  async evaluateAll(): Promise<SloEvaluation[]> {
    const out: SloEvaluation[] = []
    for (const slo of this.slos.values()) {
      out.push(await this.evaluate(slo.id))
    }
    return out
  }

  /** Pure: days until the error budget is exhausted at the current burn rate. */
  daysToBudgetExhaustion(evaluation: SloEvaluation): number | undefined {
    if (evaluation.burnRate === undefined || evaluation.errorBudgetRemaining === undefined) return undefined
    if (evaluation.burnRate <= 1) return undefined // not burning (or under target)
    // budget is consumed at burnRate times the allowed rate; remaining fraction / burnRate = fraction of window left
    const windowDays = 1 // normalized: the budget depletes over 1 window at burnRate=1
    return (evaluation.errorBudgetRemaining / evaluation.burnRate) * windowDays
  }
}
