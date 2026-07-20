import { createTriggerRuntime } from './triggerRuntime'
import type { TriggerEntry } from '../../types'

const cases: Array<{ name: string; run: () => void | Promise<void> }> = []
function test(n: string, r: () => void | Promise<void>) { cases.push({ name: n, run: r }) }

function mkDeps(persisted: TriggerEntry[] = []) {
  const fired: string[] = []
  const pubHolder: { terminalPub?: any; monitorPub?: any } = {}
  const am = {
    listTriggers: () => persisted,
  } as any
  const terminalService = {
    setRawEventPublisher(pub: any) { pubHolder.terminalPub = pub },
  } as any
  const monitorService = {
    setPublisher(pub: any) { pubHolder.monitorPub = pub },
  } as any
  const deps = {
    automationManager: am,
    terminalService,
    monitorService,
    runPlaybook: async (id: string) => { fired.push(id); return `ok:${id}` },
    onLog: () => {},
  }
  return { deps, fired, pubHolder }
}

test('loads persisted triggers on construction', () => {
  const { deps } = mkDeps([{ id: 't1', name: 'cpu', enabled: true, kind: 'threshold', action: 'run-playbook', playbookId: 'pb1', metric: 'cpu', op: 'gt', value: 90, createdAt: 1 }])
  const engine = createTriggerRuntime(deps)
  if (engine.list().length !== 1) throw new Error('persisted trigger not loaded')
  if (engine.list()[0].name !== 'cpu') throw new Error('wrong trigger loaded')
})

test('terminal:data events feed pattern triggers', async () => {
  const { deps, fired, pubHolder } = mkDeps([{ id: 't1', name: 'err', enabled: true, kind: 'pattern', action: 'run-playbook', playbookId: 'pb1', match: 'ERROR', createdAt: 1 }])
  createTriggerRuntime(deps)
  if (!pubHolder.terminalPub) throw new Error('terminal publisher not wired')
  pubHolder.terminalPub('terminal:data', { terminalId: 'web-1', data: 'something ERROR happened' })
  await new Promise((r) => setTimeout(r, 10))
  if (!fired.includes('pb1')) throw new Error('pattern trigger not fired by terminal data')
})

test('monitor:snapshot events feed threshold triggers', async () => {
  const { deps, fired, pubHolder } = mkDeps([{ id: 't1', name: 'cpu', enabled: true, kind: 'threshold', action: 'run-playbook', playbookId: 'pb1', metric: 'cpuUsagePercent', op: 'gt', value: 90, createdAt: 1 }])
  createTriggerRuntime(deps)
  if (!pubHolder.monitorPub) throw new Error('monitor publisher not wired')
  pubHolder.monitorPub('monitor:snapshot', { terminalId: 'web-1', cpuUsagePercent: 95 })
  await new Promise((r) => setTimeout(r, 10))
  if (!fired.includes('pb1')) throw new Error('threshold trigger not fired by snapshot')
})

test('non-matching events do not fire', async () => {
  const { deps, fired, pubHolder } = mkDeps([{ id: 't1', name: 'err', enabled: true, kind: 'pattern', action: 'run-playbook', playbookId: 'pb1', match: 'ERROR', createdAt: 1 }])
  createTriggerRuntime(deps)
  pubHolder.terminalPub('terminal:data', { terminalId: 'web-1', data: 'all good' })
  pubHolder.terminalPub('other-channel', { terminalId: 'web-1', data: 'ERROR' })
  await new Promise((r) => setTimeout(r, 10))
  if (fired.length !== 0) throw new Error('should not have fired')
})

test('works without a monitor service (terminal only)', () => {
  const { deps } = mkDeps([])
  deps.monitorService = null
  const engine = createTriggerRuntime(deps)
  if (!engine) throw new Error('engine should be created without monitor')
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
