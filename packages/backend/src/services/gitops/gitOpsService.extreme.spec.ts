import { GitOpsService, assertManifest, buildManifest, diffManifest, specDiff, type DesiredEntity } from './gitOpsService'

const cases: Array<{ name: string; run: () => void | Promise<void> }> = []
function test(n: string, r: () => void | Promise<void>) { cases.push({ name: n, run: r }) }
function eq(a: unknown, b: unknown, m = '') { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`) }
function ok(v: unknown, m = '') { if (!v) throw new Error(m || 'expected truthy') }
function throws(fn: () => void, m = '') { let t = false; try { fn() } catch { t = true } if (!t) throw new Error(m || 'expected throw') }

const ent = (id: string, kind: string, spec: Record<string, unknown>): DesiredEntity => ({ id, kind, spec })

// ─── buildManifest ───
test('buildManifest sorts entities + computes a stable stateHash', () => {
  const m1 = buildManifest([ent('b', 'k', { x: 1 }), ent('a', 'k', { y: 2 })])
  const m2 = buildManifest([ent('a', 'k', { y: 2 }), ent('b', 'k', { x: 1 })])
  eq(m1.entities.map((e) => e.id), ['a', 'b'])
  eq(m1.stateHash, m2.stateHash) // order-independent
})
test('buildManifest hash changes when a spec changes', () => {
  const m1 = buildManifest([ent('a', 'k', { x: 1 })])
  const m2 = buildManifest([ent('a', 'k', { x: 2 })])
  ok(m1.stateHash !== m2.stateHash)
})
test('buildManifest hash is key-order-independent within specs', () => {
  const m1 = buildManifest([ent('a', 'k', { x: 1, y: 2 })])
  const m2 = buildManifest([ent('a', 'k', { y: 2, x: 1 })])
  eq(m1.stateHash, m2.stateHash)
})

// ─── specDiff ───
test('specDiff reports changed/added/removed fields', () => {
  const d = specDiff({ a: 1, b: 2, c: 3 }, { a: 1, b: 99, d: 4 })
  const fields = d.map((x) => x.field).sort()
  eq(fields, ['b', 'c', 'd'])
})
test('specDiff empty when identical', () => {
  eq(specDiff({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 }), [])
})

// ─── diffManifest ───
test('diffManifest detects added/removed/changed', () => {
  const repo = buildManifest([
    ent('keep', 'connection', { host: 'h1' }),
    ent('change', 'playbook', { steps: 2 }),
    ent('add', 'trigger', { on: 'x' }),
  ])
  const live = [
    ent('keep', 'connection', { host: 'h1' }),
    ent('change', 'playbook', { steps: 3 }), // changed
    ent('remove', 'template', { body: 'x' }), // not in repo
  ]
  const drift = diffManifest(repo, live)
  const byId = Object.fromEntries(drift.map((d) => [d.id, d.drift]))
  eq(byId.add, 'added')
  eq(byId.remove, 'removed')
  eq(byId.change, 'changed')
  ok(!byId.keep, 'in-sync entity not flagged')
})
test('diffManifest changed includes fieldDiffs', () => {
  const repo = buildManifest([ent('x', 'k', { a: 1 })])
  const drift = diffManifest(repo, [ent('x', 'k', { a: 2 })])
  eq(drift[0].fieldDiffs![0].field, 'a')
  eq(drift[0].fieldDiffs![0].repo, 1)
  eq(drift[0].fieldDiffs![0].live, 2)
})

// ─── GitOpsService ───
test('exportLive builds a manifest from live state', async () => {
  const s = new GitOpsService({ readLive: () => [ent('a', 'k', { x: 1 })] })
  const m = await s.exportLive()
  eq(m.entities.length, 1)
  ok(m.stateHash)
})
test('constructor requires readLive', () => {
  throws(() => new GitOpsService({} as any))
})
test('inSync true when no drift, false otherwise', async () => {
  const live = [ent('a', 'k', { x: 1 })]
  const s = new GitOpsService({ readLive: () => live })
  ok(await s.inSync(buildManifest(live)))
  ok(!(await s.inSync(buildManifest([ent('a', 'k', { x: 2 })]))))
})
test('drift/inSync/reconcile reject a missing manifest with a clear error (not a TypeError)', async () => {
  const s = new GitOpsService({ readLive: () => [ent('a', 'k', { x: 1 })] })
  for (const bad of [undefined, null, {}, { entities: 'nope' }, 42]) {
    let msg = ''
    try { await s.drift(bad as never) } catch (e) { msg = (e as Error).message }
    ok(msg.includes('StateManifest'), `drift(${JSON.stringify(bad)}) should name StateManifest, got: ${msg}`)
    ok(!msg.includes("reading 'entities'"), 'must not be the opaque TypeError')
    let msg2 = ''
    try { await s.inSync(bad as never) } catch (e) { msg2 = (e as Error).message }
    ok(msg2.includes('StateManifest'), 'inSync should name StateManifest')
  }
})
test('assertManifest passes a valid manifest', () => {
  assertManifest(buildManifest([ent('a', 'k', { x: 1 })]))
})
test('reconcile upserts added/changed + calls onReconciled', async () => {
  const applied: Array<[string, string]> = []
  const live = [ent('keep', 'k', { v: 1 }), ent('change', 'k', { v: 1 })]
  const s = new GitOpsService({
    readLive: () => live,
    applyEntity: async (action, e) => { applied.push([action, e.id]) },
    onReconciled: (h, n) => { eq(h, h); eq(n, 2) },
  })
  const repo = buildManifest([ent('keep', 'k', { v: 1 }), ent('change', 'k', { v: 2 }), ent('new', 'k', { v: 0 })])
  const res = await s.reconcile(repo)
  eq(res.applied.length, 2)
  ok(applied.some(([a, id]) => a === 'upsert' && id === 'change'))
  ok(applied.some(([a, id]) => a === 'upsert' && id === 'new'))
  ok(!applied.some(([, id]) => id === 'keep'), 'in-sync not applied')
  eq(s.lastReconciledHash(), repo.stateHash)
})
test('reconcile deletes removed only when deleteRemoved != false', async () => {
  const applied: Array<[string, string]> = []
  const live = [ent('old', 'k', {})]
  const s = new GitOpsService({ readLive: () => live, applyEntity: async (a, e) => { applied.push([a, e.id]) } })
  const repo = buildManifest([])
  const r1 = await s.reconcile(repo, { deleteRemoved: false })
  eq(r1.applied.length, 0) // skipped
  const r2 = await s.reconcile(repo, { deleteRemoved: true })
  eq(r2.applied.length, 1)
  ok(applied.some(([a, id]) => a === 'delete' && id === 'old'))
})
test('reconcile collects per-entity errors (best-effort)', async () => {
  const live: DesiredEntity[] = []
  const s = new GitOpsService({
    readLive: () => live,
    applyEntity: async (_a, e) => { if (e.id === 'bad') throw new Error('apply failed') },
  })
  const repo = buildManifest([ent('good', 'k', {}), ent('bad', 'k', {})])
  const res = await s.reconcile(repo)
  eq(res.applied.length, 1)
  eq(res.errors.length, 1)
  eq(res.errors[0].id, 'bad')
})
test('reconcile without applyEntity throws', async () => {
  const s = new GitOpsService({ readLive: () => [] })
  let threw = false
  try { await s.reconcile(buildManifest([])) } catch { threw = true }
  ok(threw)
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
