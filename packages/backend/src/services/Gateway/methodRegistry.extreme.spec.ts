/**
 * methodRegistry.extreme.spec — API self-discovery (v3.0.0): the registry is the
 * single source of truth; gateway:describe returns the full surface; the agent
 * tool lists methods from the same registry. No drift between registry and the
 * observability bridge method list.
 */
import { buildDescribePayload, CORE_METHODS, DESCRIBE_METHOD, METHOD_CATEGORIES } from './methodRegistry'
import { OBSERVABILITY_METHODS } from './observabilityBridge'

const cases: Array<{ name: string; run: () => void | Promise<void> }> = []
function test(n: string, r: () => void | Promise<void>) { cases.push({ name: n, run: r }) }
function ok(v: unknown, m = '') { if (!v) throw new Error(m || 'expected truthy') }
function eq(a: unknown, b: unknown, m = '') { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`) }

test('registry includes core methods, the describe method itself, and all observability methods', () => {
  const payload = buildDescribePayload(OBSERVABILITY_METHODS.map((name) => ({ name })))
  const names = payload.methods.map((mm) => mm.name)
  ok(CORE_METHODS.length > 60, `expected 60+ core methods, got ${CORE_METHODS.length}`)
  ok(names.includes('gateway:describe'), 'describe method must be self-listed')
  ok(names.includes('settings:get') && names.includes('settings:set'), 'settings methods present')
  for (const o of OBSERVABILITY_METHODS) ok(names.includes(o), `observability method missing from registry: ${o}`)
})

test('describe payload has no duplicate method names + valid categories', () => {
  const payload = buildDescribePayload(OBSERVABILITY_METHODS.map((name) => ({ name })))
  const names = payload.methods.map((mm) => mm.name)
  eq(new Set(names).size, names.length, 'duplicate method names in registry')
  for (const mm of payload.methods) {
    ok((METHOD_CATEGORIES as readonly string[]).includes(mm.category), `method ${mm.name} has unknown category ${mm.category}`)
    ok(mm.description && mm.description.length > 5, `method ${mm.name} missing a description`)
  }
})

test('no drift: every OBSERVABILITY_METHODS entry is in the registry', () => {
  const payload = buildDescribePayload(OBSERVABILITY_METHODS.map((name) => ({ name })))
  const set = new Set(payload.methods.map((mm) => mm.name))
  for (const o of OBSERVABILITY_METHODS) {
    ok(set.has(o), `drift: observability method ${o} not in registry`)
  }
})

test('describe method metadata is self-consistent', () => {
  eq(DESCRIBE_METHOD.name, 'gateway:describe')
  eq(DESCRIBE_METHOD.category, 'gateway')
  ok(DESCRIBE_METHOD.since === '3.0.0', 'describe since should be 3.0.0')
  ok(DESCRIBE_METHOD.params?.category?.optional === true, 'category param should be optional')
  ok(DESCRIBE_METHOD.params?.prefix?.optional === true, 'prefix param should be optional')
})

test('filtering by category and prefix works (mirrors adapter + tool logic)', () => {
  const payload = buildDescribePayload(OBSERVABILITY_METHODS.map((name) => ({ name })))
  const obsOnly = payload.methods.filter((mm) => mm.category === 'observability')
  eq(obsOnly.length, OBSERVABILITY_METHODS.length, 'observability category count mismatch')
  const settingsPrefix = payload.methods.filter((mm) => mm.name.startsWith('settings:'))
  ok(settingsPrefix.length >= 4, 'settings: prefix should match get/set/getCommandPolicyLists/add+delete rule')
  ok(settingsPrefix.every((mm) => mm.name.startsWith('settings:')), 'prefix filter leaked a non-settings method')
})

test('count reflects total (core + describe + observability)', () => {
  const payload = buildDescribePayload(OBSERVABILITY_METHODS.map((name) => ({ name })))
  eq(payload.count, CORE_METHODS.length + 1 + OBSERVABILITY_METHODS.length, 'total count mismatch')
})

async function main() {
  let pass = 0, fail = 0
  for (const c of cases) {
    try { await c.run(); pass++; console.log(`PASS ${c.name}`) }
    catch (e: unknown) { fail++; console.log(`FAIL ${c.name}: ${e instanceof Error ? e.message : String(e)}`) }
  }
  console.log(`\n${pass}/${cases.length} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}
void main()
