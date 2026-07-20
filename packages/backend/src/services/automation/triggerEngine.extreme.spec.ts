import { TriggerEngine, type TriggerEntry } from './triggerEngine'

const cases: Array<{ name: string; run: () => void | Promise<void> }> = []
function test(n: string, r: () => void | Promise<void>) { cases.push({ name: n, run: r }) }

let T = 1_000_000
const now = () => T
function mkEngine(calls: string[], opts: Partial<ConstructorParameters<typeof TriggerEngine>[0]> = {}) {
  return new TriggerEngine({
    runPlaybook: async (id: string) => { calls.push(`run:${id}`); return `ok:${id}` },
    proposeChange: async (id: string) => { calls.push(`change:${id}`); return `chg:${id}` },
    now,
    ...opts,
  })
}
function trg(o: Partial<TriggerEntry> & Pick<TriggerEntry, 'name' | 'kind' | 'action' | 'playbookId'>): Omit<TriggerEntry, 'id' | 'createdAt' | 'fireCount' | 'lastFiredAt'> {
  return { enabled: true, ...o }
}

test('pattern trigger fires run-playbook on terminal output match', async () => {
  const calls: string[] = []
  const e = mkEngine(calls)
  e.upsert(trg({ name: 'err-watch', kind: 'pattern', action: 'run-playbook', playbookId: 'pb1', match: 'ERROR' }))
  e.handleTerminalData('web-1', 'all good\nsomething ERROR happened\n')
  await new Promise((r) => setTimeout(r, 10))
  if (!calls.includes('run:pb1')) throw new Error('playbook not fired')
})

test('pattern trigger does NOT fire when output does not match', async () => {
  const calls: string[] = []
  const e = mkEngine(calls)
  e.upsert(trg({ name: 'err-watch', kind: 'pattern', action: 'run-playbook', playbookId: 'pb1', match: 'ERROR' }))
  e.handleTerminalData('web-1', 'everything is fine\n')
  await new Promise((r) => setTimeout(r, 10))
  if (calls.length !== 0) throw new Error('should not have fired')
})

test('pattern regex mode matches with a regex', async () => {
  const calls: string[] = []
  const e = mkEngine(calls)
  e.upsert(trg({ name: 'bgp-down', kind: 'pattern', action: 'run-playbook', playbookId: 'pb1', match: 'BGP.*DOWN', matchMode: 'regex' }))
  e.handleTerminalData('rtr-1', 'Neighbor 10.0.0.1 BGP session went DOWN\n')
  await new Promise((r) => setTimeout(r, 10))
  if (!calls.includes('run:pb1')) throw new Error('regex pattern did not fire')
})

test('scopeHosts limits firing to matching hosts only', async () => {
  const calls: string[] = []
  const e = mkEngine(calls)
  e.upsert(trg({ name: 'err', kind: 'pattern', action: 'run-playbook', playbookId: 'pb1', match: 'ERR', scopeHosts: ['web-1'] }))
  e.handleTerminalData('db-1', 'ERR here')   // out of scope
  e.handleTerminalData('web-1', 'ERR here')   // in scope
  await new Promise((r) => setTimeout(r, 10))
  if (calls.length !== 1) throw new Error(`expected 1 fire (scoped), got ${calls.length}`)
})

test('disabled trigger never fires', async () => {
  const calls: string[] = []
  const e = mkEngine(calls)
  const t = e.upsert(trg({ name: 'err', kind: 'pattern', action: 'run-playbook', playbookId: 'pb1', match: 'ERR' }))
  e.setEnabled(t.id, false)
  e.handleTerminalData('h', 'ERR')
  await new Promise((r) => setTimeout(r, 10))
  if (calls.length !== 0) throw new Error('disabled trigger fired')
})

test('threshold trigger fires when metric crosses gt', async () => {
  const calls: string[] = []
  const e = mkEngine(calls)
  e.upsert(trg({ name: 'cpu-high', kind: 'threshold', action: 'run-playbook', playbookId: 'pb1', metric: 'cpuUsagePercent', op: 'gt', value: 90 }))
  e.handleMonitorSnapshot('web-1', { cpuUsagePercent: 95 })
  await new Promise((r) => setTimeout(r, 10))
  if (!calls.includes('run:pb1')) throw new Error('threshold did not fire')
})

test('threshold trigger does not fire below threshold', async () => {
  const calls: string[] = []
  const e = mkEngine(calls)
  e.upsert(trg({ name: 'cpu-high', kind: 'threshold', action: 'run-playbook', playbookId: 'pb1', metric: 'cpuUsagePercent', op: 'gt', value: 90 }))
  e.handleMonitorSnapshot('web-1', { cpuUsagePercent: 50 })
  await new Promise((r) => setTimeout(r, 10))
  if (calls.length !== 0) throw new Error('fired below threshold')
})

test('threshold operators lte/gte/eq work', async () => {
  const mk = (op: any, value: number, actual: number) => {
    const e = mkEngine([])
    e.upsert(trg({ name: 'm', kind: 'threshold', action: 'run-playbook', playbookId: 'p', metric: 'm', op, value }))
    let fired = false
    ;(e as any).fire = async () => { fired = true }
    e.handleMonitorSnapshot('h', { m: actual })
    return fired
  }
  if (!mk('lte', 90, 90)) throw new Error('lte edge')
  if (mk('lte', 90, 91)) throw new Error('lte over')
  if (!mk('gte', 90, 90)) throw new Error('gte edge')
  if (!mk('eq', 5, 5)) throw new Error('eq')
  if (mk('eq', 5, 6)) throw new Error('eq mismatch')
})

test('propose-change action routes to proposeChange, not runPlaybook', async () => {
  const calls: string[] = []
  const e = mkEngine(calls)
  e.upsert(trg({ name: 'err', kind: 'pattern', action: 'propose-change', playbookId: 'pb1', match: 'ERR' }))
  e.handleTerminalData('h', 'ERR')
  await new Promise((r) => setTimeout(r, 10))
  if (!calls.includes('change:pb1')) throw new Error('proposeChange not called')
  if (calls.includes('run:pb1')) throw new Error('runPlaybook should NOT be called for propose-change')
})

test('cooldown prevents rapid re-firing', async () => {
  const calls: string[] = []
  const e = mkEngine(calls)
  e.upsert(trg({ name: 'err', kind: 'pattern', action: 'run-playbook', playbookId: 'pb1', match: 'ERR', cooldownSeconds: 60 }))
  e.handleTerminalData('h', 'ERR')
  await new Promise((r) => setTimeout(r, 10))
  T += 30_000 // 30s later, still inside 60s cooldown
  e.handleTerminalData('h', 'ERR')
  await new Promise((r) => setTimeout(r, 10))
  if (calls.length !== 1) throw new Error(`expected 1 fire (cooldown), got ${calls.length}`)
})

test('cooldown elapses -> fires again', async () => {
  const calls: string[] = []
  const e = mkEngine(calls)
  e.upsert(trg({ name: 'err', kind: 'pattern', action: 'run-playbook', playbookId: 'pb1', match: 'ERR', cooldownSeconds: 60 }))
  e.handleTerminalData('h', 'ERR')
  await new Promise((r) => setTimeout(r, 10))
  T += 61_000
  e.handleTerminalData('h', 'ERR')
  await new Promise((r) => setTimeout(r, 10))
  if (calls.length !== 2) throw new Error(`expected 2 fires after cooldown, got ${calls.length}`)
})

test('fire records accumulate with reason + outcome', async () => {
  const e = mkEngine([])
  e.upsert(trg({ name: 'err', kind: 'pattern', action: 'run-playbook', playbookId: 'pb1', match: 'ERR' }))
  e.handleTerminalData('h', 'ERR')
  await new Promise((r) => setTimeout(r, 10))
  const fires = e.listFires()
  if (fires.length !== 1) throw new Error('expected 1 fire record')
  if (!/ERR/.test(fires[0].reason)) throw new Error('reason not recorded')
  if (fires[0].outcome !== 'ok:pb1') throw new Error(`outcome ${fires[0].outcome}`)
})

test('webhook trigger fires on manual fire_webhook', async () => {
  const calls: string[] = []
  const e = mkEngine(calls)
  e.upsert(trg({ name: 'hook', kind: 'webhook', action: 'run-playbook', playbookId: 'pb1' }))
  e.fire_webhook(undefined, 'external-ci')
  await new Promise((r) => setTimeout(r, 10))
  if (!calls.includes('run:pb1')) throw new Error('webhook did not fire')
})

test('upsert by name merges into existing trigger', () => {
  const e = mkEngine([])
  const a = e.upsert(trg({ name: 'err', kind: 'pattern', action: 'run-playbook', playbookId: 'pb1', match: 'ERR' }))
  const b = e.upsert(trg({ name: 'err', kind: 'pattern', action: 'run-playbook', playbookId: 'pb2', match: 'WARN' }))
  if (a.id !== b.id) throw new Error('upsert should merge by name')
  if (e.list().length !== 1) throw new Error('should be 1 trigger after merge')
  if (e.get('err')!.playbookId !== 'pb2') throw new Error('merge did not update fields')
})

test('remove deletes a trigger', () => {
  const e = mkEngine([])
  e.upsert(trg({ name: 'err', kind: 'pattern', action: 'run-playbook', playbookId: 'pb1', match: 'ERR' }))
  if (!e.remove('err')) throw new Error('remove returned false')
  if (e.list().length !== 0) throw new Error('trigger not removed')
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
