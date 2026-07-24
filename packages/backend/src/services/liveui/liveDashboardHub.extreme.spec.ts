import { LiveDashboardHub } from './liveDashboardHub'

const cases: Array<{ name: string; run: () => void | Promise<void> }> = []
function test(n: string, r: () => void | Promise<void>) { cases.push({ name: n, run: r }) }
function eq(a: unknown, b: unknown, m = '') { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`) }
function ok(v: unknown, m = '') { if (!v) throw new Error(m || 'expected truthy') }
function throws(fn: () => void, m = '') { let t = false; try { fn() } catch { t = true } if (!t) throw new Error(m || 'expected throw') }
async function throwsAsync(fn: () => Promise<void>, m = '') { let t = false; try { await fn() } catch { t = true } if (!t) throw new Error(m || 'expected throw') }

const mkState = () => ({ goldenSignals: { cpu: 50 }, incidents: [{ id: 'i1' }], slo: { burn: 1.2 } })

// ─── construction + validation ───
test('constructor requires getState', () => {
  throws(() => new LiveDashboardHub({} as any))
})
test('subscribe validates id + send', async () => {
  const hub = new LiveDashboardHub({ getState: mkState })
  await throwsAsync(() => hub.subscribe({ id: '', send: () => {} } as any))
  await throwsAsync(() => hub.subscribe({ id: 'x' } as any))
})

// ─── subscribe + replay ───
test('new subscriber immediately receives current state (replay)', async () => {
  const hub = new LiveDashboardHub({ getState: mkState })
  const got: unknown[] = []
  await hub.subscribe({ id: 'c1', send: (p) => got.push(p) })
  eq(got.length, 1)
  eq((got[0] as any).goldenSignals.cpu, 50)
})
test('replay can be disabled', async () => {
  const hub = new LiveDashboardHub({ getState: mkState, replayOnSubscribe: false })
  const got: unknown[] = []
  await hub.subscribe({ id: 'c1', send: (p) => got.push(p) })
  eq(got.length, 0)
})

// ─── publish to all subscribers ───
test('publish pushes to all subscribers + counts pushes', async () => {
  const hub = new LiveDashboardHub({ getState: mkState })
  const a: unknown[] = []
  const b: unknown[] = []
  await hub.subscribe({ id: 'a', send: (p) => a.push(p) })
  await hub.subscribe({ id: 'b', send: (p) => b.push(p) })
  eq(hub.subscriberCount(), 2)
  const delivered = await hub.publish()
  eq(delivered, 2)
  eq(a.length, 2) // replay + publish
  eq(b.length, 2) // replay + publish
  eq(hub.pushes(), 1)
})
test('a dead subscriber does not break the broadcast', async () => {
  const hub = new LiveDashboardHub({ getState: mkState, replayOnSubscribe: false })
  const good: unknown[] = []
  await hub.subscribe({ id: 'bad', send: () => { throw new Error('dead') } })
  await hub.subscribe({ id: 'good', send: (p) => good.push(p) })
  const delivered = await hub.publish()
  eq(delivered, 1) // only the good one got it
  eq(good.length, 1)
})

// ─── per-client filters ───
test('section filter delivers only requested sections', async () => {
  const hub = new LiveDashboardHub({ getState: mkState })
  const got: unknown[] = []
  await hub.subscribe({ id: 'slo-only', filter: { sections: ['slo'] }, send: (p) => got.push(p) })
  eq((got[0] as any).slo.burn, 1.2)
  ok(!('goldenSignals' in (got[0] as any)), 'other sections filtered out')
})
test('host filter uses scopeToHost', async () => {
  const hub = new LiveDashboardHub({
    getState: mkState,
    scopeToHost: (s, host) => ({ scoped: host, data: s }),
  })
  const got: unknown[] = []
  await hub.subscribe({ id: 'h', filter: { host: 'web-01' }, send: (p) => got.push(p) })
  eq((got[0] as any).scoped, 'web-01')
})
test('unfiltered subscriber gets the full state', async () => {
  const hub = new LiveDashboardHub({ getState: mkState })
  const got: unknown[] = []
  await hub.subscribe({ id: 'full', send: (p) => got.push(p) })
  ok('goldenSignals' in (got[0] as any) && 'incidents' in (got[0] as any))
})

// ─── unsubscribe ───
test('unsubscribe stops delivery + unsubscribe fn works', async () => {
  const hub = new LiveDashboardHub({ getState: mkState })
  const got: unknown[] = []
  const off = await hub.subscribe({ id: 'c', send: (p) => got.push(p) })
  eq(hub.subscriberCount(), 1)
  off()
  eq(hub.subscriberCount(), 0)
  const n = await hub.publish()
  eq(n, 0)
})

// ─── lastState ───
test('lastState reflects the latest publish; null before any', async () => {
  const hub = new LiveDashboardHub({ getState: mkState })
  eq(hub.lastState(), null)
  await hub.publish()
  ok(hub.lastState() !== null)
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
