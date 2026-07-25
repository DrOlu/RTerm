import { migrateBackendSettings } from './migrations'
import { deepMerge } from './objectMerge'

const cases: Array<{ name: string; run: () => void }> = []
function test(n: string, r: () => void) { cases.push({ name: n, run: r }) }
function eq(a: unknown, b: unknown, m = '') { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected=${JSON.stringify(b)} actual=${JSON.stringify(a)}`) }

// ─── settings:set merge must preserve sibling cost fields when only one is sent ───
test('deepMerge of {cost:{budgets}} preserves existing modelPrices', () => {
  const current = migrateBackendSettings({
    schemaVersion: 4,
    cost: { modelPrices: { 'kimi-k3': { promptPer1M: 3, completionPer1M: 15 } }, budgets: [] },
  })
  // simulate a UI/agent save that only touches budgets
  const merged = deepMerge(current, { cost: { budgets: [{ id: 'b1', period: 'daily', capUsd: 10 }] } } as never)
  const migrated = migrateBackendSettings(merged)
  eq(migrated.cost!.modelPrices['kimi-k3'].promptPer1M, 3, 'modelPrices must survive a budgets-only save')
  eq(migrated.cost!.budgets.length, 1, 'budget applied')
})

test('deepMerge of {cost:{modelPrices}} preserves existing budgets', () => {
  const current = migrateBackendSettings({
    schemaVersion: 4,
    cost: { modelPrices: {}, budgets: [{ id: 'keep', period: 'monthly', capUsd: 500 }] },
  })
  const merged = deepMerge(current, { cost: { modelPrices: { 'gpt': { promptPer1M: 5, completionPer1M: 30 } } } } as never)
  const migrated = migrateBackendSettings(merged)
  eq(migrated.cost!.budgets[0].id, 'keep', 'budgets must survive a prices-only save')
  eq(migrated.cost!.modelPrices['gpt'].completionPer1M, 30, 'price applied')
})

// ─── normalizers: hostile / edge inputs ───
test('cost normalizer survives null/undefined/garbage cost block', () => {
  for (const bad of [null, undefined, 42, 'x', [], { modelPrices: 'junk' }, { budgets: 'junk' }]) {
    const m = migrateBackendSettings({ schemaVersion: 4, cost: bad } as never)
    eq(typeof m.cost!.modelPrices, 'object', `modelPrices object for ${JSON.stringify(bad)}`)
    eq(Array.isArray(m.cost!.budgets), true, `budgets array for ${JSON.stringify(bad)}`)
  }
})

test('cost normalizer coerces numeric strings + drops NaN prices', () => {
  const m = migrateBackendSettings({
    schemaVersion: 4,
    cost: { modelPrices: { a: { promptPer1M: '3.5' as never, completionPer1M: 'NaN' as never } }, budgets: [] },
  })
  eq(m.cost!.modelPrices['a'].promptPer1M, 3.5, 'numeric string coerced')
  eq(m.cost!.modelPrices['a'].completionPer1M, 0, 'NaN clamped to 0')
})

test('alerts/oncall/cloud normalizers survive garbage blocks', () => {
  const m = migrateBackendSettings({
    schemaVersion: 4,
    alerts: 'junk',
    oncall: 42,
    cloud: null,
  } as never)
  eq(Array.isArray(m.alerts!.channels), true, 'alerts channels array')
  eq(Array.isArray(m.oncall!.pagingChannels), true, 'oncall pagingChannels array')
  eq(Array.isArray(m.cloud!.accounts), true, 'cloud accounts array')
})

test('oncall normalizer keeps inline webhookUrl AND secretRef independently', () => {
  const m = migrateBackendSettings({
    schemaVersion: 4,
    oncall: { pagingChannels: [{ id: 'h', name: 'hook', type: 'webhook', enabled: true, webhookUrl: 'https://x', secretRef: 'vault-key' }] },
  })
  const ch = m.oncall!.pagingChannels[0]
  eq(ch.webhookUrl, 'https://x', 'inline url kept')
  eq(ch.secretRef, 'vault-key', 'secretRef kept')
})

function main() {
  let pass = 0, fail = 0
  for (const c of cases) {
    try { c.run(); pass++; console.log(`PASS ${c.name}`) }
    catch (e: unknown) { fail++; console.log(`FAIL ${c.name}: ${e instanceof Error ? e.message : String(e)}`) }
  }
  console.log(`\n${pass}/${cases.length} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}
void main()
