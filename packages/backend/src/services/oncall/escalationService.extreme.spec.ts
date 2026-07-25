import { EscalationService, type EscalationPolicy } from './escalationService'

const cases: Array<{ name: string; run: () => void | Promise<void> }> = []
function test(n: string, r: () => void | Promise<void>) { cases.push({ name: n, run: r }) }
function eq(a: unknown, b: unknown, m = '') { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`) }
function ok(v: unknown, m = '') { if (!v) throw new Error(m || 'expected truthy') }
function throws(fn: () => void, m = '') { let t = false; try { fn() } catch { t = true } if (!t) throw new Error(m || 'expected throw') }

function policy(over: Partial<EscalationPolicy> = {}): EscalationPolicy {
  return {
    id: 'pol-1', name: 'Primary on-call',
    levels: [
      { targets: [{ id: '@alice', channel: 'slack' }], ackTimeoutMs: 1000 },
      { targets: [{ id: '@bob', channel: 'slack' }, { id: 'ops@x.com', channel: 'email' }], ackTimeoutMs: 2000 },
    ],
    ...over,
  }
}

// ─── policy validation ───
test('registerPolicy rejects empty levels', () => {
  const s = new EscalationService()
  throws(() => s.registerPolicy({ id: 'p', name: 'p', levels: [] }))
})
test('registerPolicy rejects level with no targets', () => {
  const s = new EscalationService()
  throws(() => s.registerPolicy({ id: 'p', name: 'p', levels: [{ targets: [], ackTimeoutMs: 100 }] }))
})
test('registerPolicy rejects bad ackTimeoutMs', () => {
  const s = new EscalationService()
  throws(() => s.registerPolicy({ id: 'p', name: 'p', levels: [{ targets: [{ id: 'a', channel: 'c' }], ackTimeoutMs: 0 }] }))
})
test('register/get/list policies', () => {
  const s = new EscalationService()
  s.registerPolicy(policy())
  s.registerPolicy(policy({ id: 'pol-2', name: 'Aardvark' }))
  ok(s.getPolicy('pol-1'))
  eq(s.listPolicies()[0].name, 'Aardvark') // sorted
})

// ─── page raising + level-0 notify ───
test('page sends level-0 notifications via channel', async () => {
  const sent: string[] = []
  const s = new EscalationService({ channels: [{ name: 'slack', send: async (t) => { sent.push(t.id); return 'ok' } }] })
  s.registerPolicy(policy())
  const p = await s.page({ incidentId: 'inc-1', policyId: 'pol-1', title: 'DB down', severity: 'sev1' })
  eq(p.status, 'open')
  eq(p.levelIndex, 0)
  eq(sent, ['@alice'])
})
test('page throws on unknown policy', async () => {
  const s = new EscalationService()
  let threw = false
  try { await s.page({ incidentId: 'i', policyId: 'ghost', title: 't', severity: 'sev1' }) } catch { threw = true }
  ok(threw)
})

// ─── ack ───
test('acknowledge stops escalation (tick does nothing)', async () => {
  let t = 0
  const s = new EscalationService({ now: () => t })
  s.registerPolicy(policy())
  const p = await s.page({ incidentId: 'i', policyId: 'pol-1', title: 't', severity: 'sev1' })
  s.acknowledge(p.id, 'alice')
  t = 10_000
  const escalated = await s.tick()
  eq(escalated.length, 0)
  eq(s.getPage(p.id)!.status, 'acknowledged')
  eq(s.getPage(p.id)!.acknowledgedBy, 'alice')
})
test('acknowledge on non-open page throws', async () => {
  const s = new EscalationService()
  s.registerPolicy(policy())
  const p = await s.page({ incidentId: 'i', policyId: 'pol-1', title: 't', severity: 'sev1' })
  s.acknowledge(p.id, 'a')
  throws(() => s.acknowledge(p.id, 'a'))
})
test('acknowledge unknown page throws', () => {
  const s = new EscalationService()
  throws(() => s.acknowledge('nope', 'a'))
})

// ─── escalation via tick ───
test('unacked page escalates to next level after timeout', async () => {
  let t = 0
  const sent: Array<{ id: string; level: number }> = []
  const s = new EscalationService({
    now: () => t,
    channels: [{ name: 'slack', send: async (tg, _p, lvl) => { sent.push({ id: tg.id, level: lvl }); return 'ok' } }],
  })
  s.registerPolicy(policy())
  const p = await s.page({ incidentId: 'i', policyId: 'pol-1', title: 't', severity: 'sev1' })
  eq(sent.map((x) => x.id), ['@alice'])
  t = 1500 // past level-0 1000ms timeout
  const esc = await s.tick()
  eq(esc.length, 1)
  eq(s.getPage(p.id)!.levelIndex, 1)
  eq(s.getPage(p.id)!.escalations, 1)
  ok(sent.some((x) => x.id === '@bob' && x.level === 1), 'bob paged at level 1')
})
test('page within timeout does NOT escalate', async () => {
  let t = 0
  const s = new EscalationService({ now: () => t })
  s.registerPolicy(policy())
  await s.page({ incidentId: 'i', policyId: 'pol-1', title: 't', severity: 'sev1' })
  t = 500
  eq((await s.tick()).length, 0)
})
test('last level timeout expires the page (no repeat)', async () => {
  let t = 0
  const s = new EscalationService({ now: () => t })
  s.registerPolicy(policy())
  const p = await s.page({ incidentId: 'i', policyId: 'pol-1', title: 't', severity: 'sev1' })
  t = 1500; await s.tick() // → level 1
  t = 1500 + 2500; await s.tick() // level-1 2000ms exceeded → expired
  eq(s.getPage(p.id)!.status, 'expired')
})
test('repeat policy loops back to level 0', async () => {
  let t = 0
  const s = new EscalationService({ now: () => t })
  s.registerPolicy(policy({ repeat: true, levels: [{ targets: [{ id: '@a', channel: 'c' }], ackTimeoutMs: 100 }] }))
  const p = await s.page({ incidentId: 'i', policyId: 'pol-1', title: 't', severity: 'sev1' })
  t = 200; await s.tick()
  eq(s.getPage(p.id)!.levelIndex, 0)
  eq(s.getPage(p.id)!.status, 'open')
})

// ─── resolve ───
test('resolve marks page resolved + is idempotent', async () => {
  const s = new EscalationService()
  s.registerPolicy(policy())
  const p = await s.page({ incidentId: 'i', policyId: 'pol-1', title: 't', severity: 'sev1' })
  s.resolve(p.id)
  eq(s.getPage(p.id)!.status, 'resolved')
  s.resolve(p.id) // no throw
})
test('resolve unknown page throws', () => {
  const s = new EscalationService()
  throws(() => s.resolve('ghost'))
})

// ─── queries ───
test('pagesForIncident + openPages', async () => {
  const s = new EscalationService()
  s.registerPolicy(policy())
  const p1 = await s.page({ incidentId: 'inc-1', policyId: 'pol-1', title: 't', severity: 'sev1' })
  await s.page({ incidentId: 'inc-2', policyId: 'pol-1', title: 't', severity: 'sev2' })
  eq(s.pagesForIncident('inc-1').length, 1)
  eq(s.openPages().length, 2)
  s.acknowledge(p1.id, 'a')
  eq(s.openPages().length, 1)
})

// ─── onNotify hook ───
test('onNotify fires per level with targets', async () => {
  const calls: number[] = []
  const s = new EscalationService({ now: (() => { let t = 0; return () => t })() , onNotify: (_p, lvl) => calls.push(lvl) })
  s.registerPolicy(policy())
  await s.page({ incidentId: 'i', policyId: 'pol-1', title: 't', severity: 'sev1' })
  eq(calls, [0])
})

// ─── live channel hot-swap (settings re-sync) ───
test('setChannels hot-swaps paging channels live (no restart)', async () => {
  const sentA: string[] = []
  const sentB: string[] = []
  const s = new EscalationService({
    channels: [{ name: 'slack', send: async (t) => { sentA.push(t.id); return 'a' } }],
  })
  s.registerPolicy(policy())
  await s.page({ incidentId: 'i1', policyId: 'pol-1', title: 't', severity: 'sev1' })
  eq(sentA, ['@alice'], 'original channel delivers level 0')
  eq(s.listChannels(), ['slack'], 'initial channel registered')

  // Hot-swap: replace 'slack' with a different sender keyed under the same name.
  s.setChannels([{ name: 'slack', send: async (t) => { sentB.push(t.id); return 'b' } }])
  eq(s.listChannels(), ['slack'], 'channel still keyed by name after swap')
  await s.page({ incidentId: 'i2', policyId: 'pol-1', title: 't', severity: 'sev1' })
  eq(sentA, ['@alice'], 'old sender no longer used after swap')
  eq(sentB, ['@alice'], 'new sender delivers after hot-swap')
})

test('setChannels can add + remove channels', async () => {
  const hits: string[] = []
  const s = new EscalationService({ channels: [] })
  eq(s.listChannels(), [], 'starts empty')
  s.setChannels([
    { name: 'slack', send: async () => { hits.push('slack'); return 's' } },
    { name: 'email', send: async () => { hits.push('email'); return 'e' } },
  ])
  eq(s.listChannels().sort(), ['email', 'slack'], 'both channels registered')
  s.setChannels([{ name: 'email', send: async () => { hits.push('email2'); return 'e' } }])
  eq(s.listChannels(), ['email'], 'removal reflects immediately')
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
