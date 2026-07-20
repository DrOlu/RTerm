import { manageTrigger, manageTriggerSchema } from './trigger_tools'
import type { TriggerEntry } from '../../../types'
import { TriggerEngine } from '../../automation/triggerEngine'

const cases: Array<{ name: string; run: () => void | Promise<void> }> = []
function test(n: string, r: () => void | Promise<void>) { cases.push({ name: n, run: r }) }

function mkContext(triggers: TriggerEntry[] = [], withEngine = true) {
  const store = { list: [...triggers] }
  const m = {
    listTriggers: () => store.list,
    upsertTrigger: (e: TriggerEntry) => {
      const i = store.list.findIndex((t) => t.id === e.id || t.name === e.name)
      if (i === -1) store.list.push(e); else store.list[i] = { ...store.list[i], ...e, id: store.list[i].id }
      return e
    },
    deleteTrigger: (k: string) => {
      const n = store.list.filter((t) => t.id !== k && t.name !== k)
      const changed = n.length !== store.list.length; store.list = n; return changed
    },
    setTriggerEnabled: (k: string, en: boolean) => {
      const t = store.list.find((x) => x.id === k || x.name === k)
      if (!t) return false; t.enabled = en; return true
    },
  }
  const events: any[] = []
  const engine = withEngine ? new TriggerEngine({ runPlaybook: async () => 'ok', now: () => 1 }) : undefined
  const ctx: any = {
    sessionId: 's1', messageId: 'm1',
    sendEvent: (_s: string, e: any) => events.push(e),
    automationManager: m,
    triggerEngine: engine,
    __store: store,
  }
  return { ctx, events, engine }
}

test('schema validates a create action', () => {
  const r = manageTriggerSchema.safeParse({ action: 'create', name: 'x', kind: 'pattern', playbookId: 'pb1', match: 'ERR' })
  if (!r.success) throw new Error('schema should accept valid create')
})

test('schema rejects an unknown action', () => {
  const r = manageTriggerSchema.safeParse({ action: 'explode' })
  if (r.success) throw new Error('schema should reject bad action')
})

test('create adds a trigger and returns confirmation', async () => {
  const { ctx } = mkContext()
  const out = await manageTrigger({ action: 'create', name: 'cpu-watch', kind: 'threshold', playbookId: 'pb1', metric: 'cpu', op: 'gt', value: 90 }, ctx)
  if (!/Created trigger "cpu-watch"/.test(out)) throw new Error(out)
  if (ctx.__store.list.length !== 1) throw new Error('trigger not stored')
  const t = ctx.__store.list[0]
  if (t.metric !== 'cpu' || t.op !== 'gt' || t.value !== 90) throw new Error('fields not stored')
})

test('create requires name, kind, playbookId', async () => {
  const { ctx } = mkContext()
  if (!/requires a name/.test(await manageTrigger({ action: 'create', kind: 'pattern', playbookId: 'p' } as any, ctx))) throw new Error('name check')
  if (!/requires a kind/.test(await manageTrigger({ action: 'create', name: 'x', playbookId: 'p' } as any, ctx))) throw new Error('kind check')
  if (!/requires playbookId/.test(await manageTrigger({ action: 'create', name: 'x', kind: 'pattern' } as any, ctx))) throw new Error('pb check')
})

test('list shows triggers with enabled state and condition', async () => {
  const { ctx } = mkContext([{ id: 't1', name: 'cpu', enabled: true, kind: 'threshold', action: 'run-playbook', playbookId: 'pb1', metric: 'cpu', op: 'gt', value: 90, createdAt: 1 }])
  const out = await manageTrigger({ action: 'list' }, ctx)
  if (!/cpu \[threshold cpu gt 90\]/.test(out)) throw new Error(out)
})

test('list on empty store says none configured', async () => {
  const { ctx } = mkContext()
  if (!/No triggers configured/.test(await manageTrigger({ action: 'list' }, ctx))) throw new Error('empty list')
})

test('update merges fields into an existing trigger', async () => {
  const { ctx } = mkContext([{ id: 't1', name: 'cpu', enabled: true, kind: 'threshold', action: 'run-playbook', playbookId: 'pb1', metric: 'cpu', op: 'gt', value: 90, createdAt: 1 }])
  await manageTrigger({ action: 'update', id: 't1', value: 95 }, ctx)
  if (ctx.__store.list[0].value !== 95) throw new Error('update did not apply')
})

test('update on missing trigger reports not found', async () => {
  const { ctx } = mkContext()
  if (!/No trigger "nope"/.test(await manageTrigger({ action: 'update', id: 'nope', value: 1 }, ctx))) throw new Error('missing update')
})

test('delete removes a trigger', async () => {
  const { ctx } = mkContext([{ id: 't1', name: 'cpu', enabled: true, kind: 'threshold', action: 'run-playbook', playbookId: 'pb1', createdAt: 1 }])
  const out = await manageTrigger({ action: 'delete', id: 't1' }, ctx)
  if (!/Deleted trigger "t1"/.test(out)) throw new Error(out)
  if (ctx.__store.list.length !== 0) throw new Error('not deleted')
})

test('enable/disable toggles enabled', async () => {
  const { ctx } = mkContext([{ id: 't1', name: 'cpu', enabled: true, kind: 'threshold', action: 'run-playbook', playbookId: 'pb1', createdAt: 1 }])
  await manageTrigger({ action: 'disable', id: 't1' }, ctx)
  if (ctx.__store.list[0].enabled !== false) throw new Error('disable failed')
  await manageTrigger({ action: 'enable', id: 't1' }, ctx)
  if (ctx.__store.list[0].enabled !== true) throw new Error('enable failed')
})

test('fires returns engine fire records', async () => {
  const { ctx, engine } = mkContext()
  engine!.upsert({ id: 't1', name: 'err', enabled: true, kind: 'pattern', action: 'run-playbook', playbookId: 'pb1', match: 'ERR' })
  engine!.handleTerminalData('h', 'ERR happened')
  await new Promise((r) => setTimeout(r, 10))
  const out = await manageTrigger({ action: 'fires' }, ctx)
  if (!/Recent trigger firings/.test(out)) throw new Error(out)
})

test('fires with no engine records reports none', async () => {
  const { ctx } = mkContext()
  if (!/No trigger firings/.test(await manageTrigger({ action: 'fires' }, ctx))) throw new Error('empty fires')
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
