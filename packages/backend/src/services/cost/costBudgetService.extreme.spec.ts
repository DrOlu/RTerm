import { CostBudgetService, costFor, periodStart, type Budget } from './costBudgetService'

const cases: Array<{ name: string; run: () => void | Promise<void> }> = []
function test(n: string, r: () => void | Promise<void>) { cases.push({ name: n, run: r }) }
function eq(a: unknown, b: unknown, m = '') { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`) }
function ok(v: unknown, m = '') { if (!v) throw new Error(m || 'expected truthy') }
function close(a: number, b: number, eps = 1e-6, m = '') { if (Math.abs(a - b) > eps) throw new Error(`${m} expected ~${b} got ${a}`) }
function throws(fn: () => void, m = '') { let t = false; try { fn() } catch { t = true } if (!t) throw new Error(m || 'expected throw') }

const DAY = 86_400_000
// 2026-07-24T12:00:00Z
const NOON = Date.UTC(2026, 6, 24, 12, 0, 0)
const prices = {
  'gpt-4o': { promptPer1M: 5, completionPer1M: 15 },
  'claude-sonnet': { promptPer1M: 3, completionPer1M: 15 },
  default: { promptPer1M: 1, completionPer1M: 2 },
}

// ─── costFor ───
test('costFor computes prompt+completion dollars', () => {
  close(costFor({ promptTokens: 1_000_000, completionTokens: 1_000_000 }, { promptPer1M: 5, completionPer1M: 15 }), 20)
})
test('costFor handles partial millions + zero', () => {
  close(costFor({ promptTokens: 500_000, completionTokens: 0 }, { promptPer1M: 4, completionPer1M: 10 }), 2)
  eq(costFor({ promptTokens: 0, completionTokens: 0 }, { promptPer1M: 4, completionPer1M: 10 }), 0)
})
test('costFor clamps negatives to zero', () => {
  eq(costFor({ promptTokens: -100, completionTokens: -5 }, { promptPer1M: 4, completionPer1M: 10 }), 0)
})

// ─── periodStart ───
test('periodStart daily = UTC midnight', () => {
  eq(periodStart(NOON, 'daily'), Date.UTC(2026, 6, 24))
})
test('periodStart monthly = first of month UTC', () => {
  eq(periodStart(NOON, 'monthly'), Date.UTC(2026, 6, 1))
})

// ─── record + summarize ───
test('record returns computed cost + summarize aggregates per model', () => {
  const s = new CostBudgetService({ prices, now: () => NOON })
  const c1 = s.record({ model: 'gpt-4o', promptTokens: 1_000_000, completionTokens: 1_000_000 })
  close(c1, 20)
  s.record({ model: 'claude-sonnet', promptTokens: 2_000_000, completionTokens: 0 })
  const sum = s.summarize({ period: 'daily' })
  close(sum.totalUsd, 26) // 20 + 6
  eq(sum.byModel[0].model, 'gpt-4o') // sorted by usd desc
  close(sum.byModel[0].usd, 20)
})
test('record uses default price for unknown model', () => {
  const s = new CostBudgetService({ prices, now: () => NOON })
  close(s.record({ model: 'some-new-model', promptTokens: 1_000_000, completionTokens: 1_000_000 }), 3)
})
test('record rejects missing model', () => {
  const s = new CostBudgetService({ prices })
  throws(() => s.record({ model: '', promptTokens: 1, completionTokens: 1 }))
})
test('summarize respects the daily window (yesterday excluded)', () => {
  const s = new CostBudgetService({ prices, now: () => NOON })
  s.record({ model: 'gpt-4o', promptTokens: 1_000_000, completionTokens: 0, at: NOON - DAY }) // yesterday
  s.record({ model: 'gpt-4o', promptTokens: 1_000_000, completionTokens: 0, at: NOON }) // today
  const sum = s.summarize({ period: 'daily' })
  close(sum.totalUsd, 5) // only today's
})
test('summarize monthly window includes whole month', () => {
  const s = new CostBudgetService({ prices, now: () => NOON })
  s.record({ model: 'gpt-4o', promptTokens: 1_000_000, completionTokens: 0, at: Date.UTC(2026, 6, 2) })
  s.record({ model: 'gpt-4o', promptTokens: 1_000_000, completionTokens: 0, at: NOON })
  close(s.summarize({ period: 'monthly' }).totalUsd, 10)
})
test('summarize filters by model + profile', () => {
  const s = new CostBudgetService({ prices, now: () => NOON })
  s.record({ model: 'gpt-4o', promptTokens: 1_000_000, completionTokens: 0, profileId: 'p1' })
  s.record({ model: 'gpt-4o', promptTokens: 1_000_000, completionTokens: 0, profileId: 'p2' })
  s.record({ model: 'claude-sonnet', promptTokens: 1_000_000, completionTokens: 0, profileId: 'p1' })
  close(s.summarize({ model: 'gpt-4o' }).totalUsd, 10)
  close(s.summarize({ profileId: 'p1' }).totalUsd, 8)
})
test('estimate does not record', () => {
  const s = new CostBudgetService({ prices, now: () => NOON })
  s.estimate({ model: 'gpt-4o', promptTokens: 1_000_000, completionTokens: 0 })
  eq(s.summarize().totalUsd, 0)
})

// ─── budgets ───
function budget(over: Partial<Budget> = {}): Budget {
  return { id: 'b1', model: 'gpt-4o', period: 'daily', capUsd: 10, ...over }
}
test('setBudget validates cap + id', () => {
  const s = new CostBudgetService({ prices })
  throws(() => s.setBudget({ id: '', period: 'daily', capUsd: 5 }))
  throws(() => s.setBudget({ id: 'x', period: 'daily', capUsd: 0 }))
})
test('budgetStatus: ok below warn threshold', () => {
  const s = new CostBudgetService({ prices, now: () => NOON })
  s.record({ model: 'gpt-4o', promptTokens: 1_000_000, completionTokens: 0 }) // $5 of $10 = 0.5
  const st = s.budgetStatus(budget())
  eq(st.action, 'ok')
  close(st.ratio, 0.5)
})
test('budgetStatus: warn at/above warnAt fraction', () => {
  const s = new CostBudgetService({ prices, now: () => NOON })
  s.record({ model: 'gpt-4o', promptTokens: 1_800_000, completionTokens: 0 }) // $9 of $10 = 0.9
  eq(s.budgetStatus(budget()).action, 'warn')
})
test('budgetStatus: over cap → throttle (default) or deny', () => {
  const s = new CostBudgetService({ prices, now: () => NOON })
  s.record({ model: 'gpt-4o', promptTokens: 2_200_000, completionTokens: 0 }) // $11 > $10
  eq(s.budgetStatus(budget()).action, 'throttle')
  eq(s.budgetStatus(budget({ overAction: 'deny' })).action, 'deny')
})
test('check returns strictest action across matching budgets', () => {
  const s = new CostBudgetService({ prices, now: () => NOON })
  s.record({ model: 'gpt-4o', promptTokens: 2_200_000, completionTokens: 0 }) // $11
  s.setBudget(budget({ id: 'b-throttle', overAction: 'throttle' }))
  s.setBudget(budget({ id: 'b-deny', overAction: 'deny' }))
  const res = s.check({ model: 'gpt-4o' })
  eq(res.action, 'deny')
  eq(res.statuses.length, 2)
})
test('check skips non-matching budgets (model/profile scope)', () => {
  const s = new CostBudgetService({ prices, now: () => NOON })
  s.record({ model: 'gpt-4o', promptTokens: 2_200_000, completionTokens: 0 })
  s.setBudget(budget({ id: 'other-model', model: 'claude-sonnet', overAction: 'deny' }))
  s.setBudget(budget({ id: 'other-profile', model: '*', profileId: 'pX', overAction: 'deny' }))
  const res = s.check({ model: 'gpt-4o', profileId: 'p1' })
  eq(res.action, 'ok')
  eq(res.statuses.length, 0)
})
test('wildcard budget (* model, no profile) matches any run', () => {
  const s = new CostBudgetService({ prices, now: () => NOON })
  s.record({ model: 'gpt-4o', promptTokens: 2_200_000, completionTokens: 0 })
  s.setBudget(budget({ id: 'all', model: '*', overAction: 'deny' }))
  eq(s.check({ model: 'anything' }).action, 'deny')
})
test('removeBudget + listBudgets', () => {
  const s = new CostBudgetService({ prices })
  s.setBudget(budget({ id: 'b2' }))
  s.setBudget(budget({ id: 'b1' }))
  eq(s.listBudgets()[0].id, 'b1')
  ok(s.removeBudget('b1'))
  eq(s.listBudgets().length, 1)
})

test('setPrices live-updates cost math without restart', () => {
  const s = new CostBudgetService({ prices, now: () => NOON })
  s.record({ model: 'gpt-4o', promptTokens: 1_000_000, completionTokens: 0 }) // $5 at old price
  eq(s.summarize({ period: 'daily', at: NOON }).totalUsd, 5)
  // live-update the price; previously-recorded events are re-priced on summarize
  s.setPrices({ 'gpt-4o': { promptPer1M: 10, completionPer1M: 30 } })
  eq(s.summarize({ period: 'daily', at: NOON }).totalUsd, 10)
})

test('setPrices + getPrices round-trips the table', () => {
  const s = new CostBudgetService({ prices, now: () => NOON })
  const next = { 'kimi-k3': { promptPer1M: 0.6, completionPer1M: 2.5 }, default: { promptPer1M: 1, completionPer1M: 2 } }
  s.setPrices(next)
  eq(s.getPrices(), next)
  // unknown model now uses the new default fallback
  s.record({ model: 'unpriced-model', promptTokens: 1_000_000, completionTokens: 0 })
  eq(s.summarize({ period: 'daily', at: NOON }).totalUsd, 1)
})

test('clearBudgets empties the registry (re-sync from settings)', () => {
  const s = new CostBudgetService({ prices })
  s.setBudget(budget({ id: 'b1' }))
  s.setBudget(budget({ id: 'b2' }))
  eq(s.listBudgets().length, 2)
  s.clearBudgets()
  eq(s.listBudgets().length, 0)
  // re-registering after clear works (settings re-sync path)
  s.setBudget(budget({ id: 'b3' }))
  eq(s.listBudgets().map((b) => b.id), ['b3'])
})

async function main() {
  let pass = 0, fail = 0
  for (const c of cases) {
    try { await c.run(); pass++; console.log(`PASS ${c.name}`) }
    catch (e: any) { fail++; console.log(`FAIL ${c.name}: ${e?.message ?? e}`) }
  }
  console.log(`\n${pass}/${cases.length} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}
void main()
