/**
 * costBudgetService — AI cost attribution + token/$ budgets (Tier 2). Turns the
 * raw token counts in the agent run ledger into dollars per model/profile/day,
 * and enforces budgets (warn / throttle / deny) so a multi-model agent setup
 * can't burn money silently.
 *
 * Pure + injectable: price table and clock are injected; usage events are fed
 * in (from the run ledger) and cost/budget status is queried.
 */

export interface ModelPrice {
  /** USD per 1M prompt/input tokens. */
  promptPer1M: number
  /** USD per 1M completion/output tokens. */
  completionPer1M: number
}

export interface UsageEvent {
  model: string
  promptTokens: number
  completionTokens: number
  /** epoch ms; defaults to now(). */
  at?: number
  /** optional profile/actor attribution. */
  profileId?: string
}

export type BudgetAction = 'ok' | 'warn' | 'throttle' | 'deny'

export interface Budget {
  id: string
  /** scope: which model(s)/profile(s) this budget covers ('*' = all). */
  model?: string
  profileId?: string
  /** window the budget is measured over. */
  period: 'daily' | 'monthly'
  /** USD cap for the window. */
  capUsd: number
  /** fraction of cap that triggers 'warn' (default 0.8). */
  warnAt?: number
  /** when over cap: 'throttle' (flag, allow) or 'deny' (block). */
  overAction?: 'throttle' | 'deny'
}

export interface CostSummary {
  totalUsd: number
  promptTokens: number
  completionTokens: number
  byModel: Array<{ model: string; usd: number; promptTokens: number; completionTokens: number }>
}

export interface BudgetStatus {
  budget: Budget
  spentUsd: number
  capUsd: number
  /** spent / cap (may exceed 1). */
  ratio: number
  action: BudgetAction
}

export interface CostBudgetDeps {
  /** price table keyed by model id ('default' fallback). */
  prices?: Record<string, ModelPrice>
  now?: () => number
}

const DEFAULT_PRICE: ModelPrice = { promptPer1M: 0, completionPer1M: 0 }

/** Compute USD cost for a usage event under a price table (pure). */
export function costFor(
  event: { promptTokens: number; completionTokens: number },
  price: ModelPrice,
): number {
  const p = Math.max(0, event.promptTokens || 0)
  const c = Math.max(0, event.completionTokens || 0)
  return (p / 1_000_000) * price.promptPer1M + (c / 1_000_000) * price.completionPer1M
}

/** Start-of-day (UTC) and start-of-month (UTC) for bucketing. */
export function periodStart(at: number, period: 'daily' | 'monthly'): number {
  const d = new Date(at)
  if (period === 'daily') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
}

export class CostBudgetService {
  private readonly prices: Record<string, ModelPrice>
  private readonly now: () => number
  private readonly events: Array<Required<Pick<UsageEvent, 'model' | 'promptTokens' | 'completionTokens'>> & { at: number; profileId?: string }> = []
  private readonly budgets = new Map<string, Budget>()

  constructor(deps: CostBudgetDeps = {}) {
    this.prices = deps.prices ?? {}
    this.now = deps.now ?? Date.now
  }

  private priceFor(model: string): ModelPrice {
    return this.prices[model] ?? this.prices['default'] ?? DEFAULT_PRICE
  }

  /** Record a usage event. Returns its computed USD cost. */
  record(event: UsageEvent): number {
    if (!event.model) throw new Error('usage event needs a model')
    const at = event.at ?? this.now()
    this.events.push({
      model: event.model,
      promptTokens: Math.max(0, event.promptTokens || 0),
      completionTokens: Math.max(0, event.completionTokens || 0),
      at,
      profileId: event.profileId,
    })
    return costFor(event, this.priceFor(event.model))
  }

  /** Cost of a single event without recording it. */
  estimate(event: { model: string; promptTokens: number; completionTokens: number }): number {
    return costFor(event, this.priceFor(event.model))
  }

  private inWindow(at: number, period: 'daily' | 'monthly', ref: number): boolean {
    return at >= periodStart(ref, period) && at < periodStart(ref, period) + (period === 'daily' ? 86_400_000 : 31 * 86_400_000)
  }

  /** Summarize spend over a window (default: current day UTC). */
  summarize(opts: { period?: 'daily' | 'monthly'; model?: string; profileId?: string; at?: number } = {}): CostSummary {
    const period = opts.period ?? 'daily'
    const ref = opts.at ?? this.now()
    const byModel = new Map<string, { usd: number; promptTokens: number; completionTokens: number }>()
    let totalUsd = 0
    let promptTokens = 0
    let completionTokens = 0
    for (const e of this.events) {
      if (!this.inWindow(e.at, period, ref)) continue
      if (opts.model && opts.model !== '*' && e.model !== opts.model) continue
      if (opts.profileId && e.profileId !== opts.profileId) continue
      const usd = costFor(e, this.priceFor(e.model))
      totalUsd += usd
      promptTokens += e.promptTokens
      completionTokens += e.completionTokens
      const agg = byModel.get(e.model) ?? { usd: 0, promptTokens: 0, completionTokens: 0 }
      agg.usd += usd
      agg.promptTokens += e.promptTokens
      agg.completionTokens += e.completionTokens
      byModel.set(e.model, agg)
    }
    return {
      totalUsd,
      promptTokens,
      completionTokens,
      byModel: [...byModel.entries()]
        .map(([model, v]) => ({ model, ...v }))
        .sort((a, b) => b.usd - a.usd),
    }
  }

  /** Register/replace a budget. */
  setBudget(budget: Budget): void {
    if (!budget.id) throw new Error('budget needs an id')
    if (!(budget.capUsd > 0)) throw new Error(`budget ${budget.id} capUsd must be > 0`)
    this.budgets.set(budget.id, budget)
  }

  removeBudget(id: string): boolean {
    return this.budgets.delete(id)
  }

  listBudgets(): Budget[] {
    return [...this.budgets.values()].sort((a, b) => a.id.localeCompare(b.id))
  }

  /** Status of one budget right now. */
  budgetStatus(budget: Budget, at?: number): BudgetStatus {
    const spent = this.summarize({ period: budget.period, model: budget.model, profileId: budget.profileId, at }).totalUsd
    const ratio = spent / budget.capUsd
    const warnAt = budget.warnAt ?? 0.8
    let action: BudgetAction = 'ok'
    if (ratio >= 1) action = budget.overAction ?? 'throttle'
    else if (ratio >= warnAt) action = 'warn'
    return { budget, spentUsd: spent, capUsd: budget.capUsd, ratio, action }
  }

  /**
   * Gate an intended run against all matching budgets. Returns the strictest
   * action across matching budgets (deny > throttle > warn > ok) and the
   * per-budget statuses. A model/profile of undefined matches wildcard budgets.
   */
  check(opts: { model?: string; profileId?: string; at?: number }): { action: BudgetAction; statuses: BudgetStatus[] } {
    const order: Record<BudgetAction, number> = { ok: 0, warn: 1, throttle: 2, deny: 3 }
    let strictest: BudgetAction = 'ok'
    const statuses: BudgetStatus[] = []
    for (const b of this.budgets.values()) {
      const modelMatch = !b.model || b.model === '*' || b.model === opts.model
      const profileMatch = !b.profileId || b.profileId === opts.profileId
      if (!modelMatch || !profileMatch) continue
      const st = this.budgetStatus(b, opts.at)
      statuses.push(st)
      if (order[st.action] > order[strictest]) strictest = st.action
    }
    return { action: strictest, statuses }
  }
}
