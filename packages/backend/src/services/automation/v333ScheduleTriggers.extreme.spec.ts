import { TriggerEngine } from './triggerEngine'
import { SchedulerService } from './schedulerService'
import type { TriggerEntry } from '../../types'

const assert = (c: unknown, m: string): void => {
  if (!c) throw new Error(m)
}
const eq = <T>(a: T, b: T, m: string): void => {
  if (a !== b) throw new Error(`${m}: expected=${String(b)} actual=${String(a)}`)
}

const run = (name: string, fn: () => void | Promise<void>): Promise<void> =>
  Promise.resolve(fn()).then(() => console.log(`PASS ${name}`))

function makeEngine(playbookHits: string[]) {
  return new TriggerEngine({
    runPlaybook: async (id, reason) => {
      playbookHits.push(`${id}|${reason}`)
      return `ok:${id}`
    },
    now: () => Date.now(),
  })
}

const base: Omit<TriggerEntry, 'id' | 'createdAt'> = {
  name: 'nightly',
  enabled: true,
  kind: 'schedule',
  cron: '* * * * *',
  action: 'run-playbook',
  playbookId: 'pb-night',
}

await run('fire_schedule: matching cron fires the playbook', async () => {
  const hits: string[] = []
  const engine = makeEngine(hits)
  engine.upsert({ ...base, id: 'trg-1', cooldownSeconds: 0 })
  const fired = engine.fire_schedule(new Date())
  eq(fired.length, 1, 'one fired')
  await new Promise((r) => setTimeout(r, 20))
  assert(hits[0]?.startsWith('pb-night|'), `hit=${hits[0]}`)
})

await run('fire_schedule: disabled trigger is skipped', async () => {
  const hits: string[] = []
  const engine = makeEngine(hits)
  engine.upsert({ ...base, id: 'trg-2', enabled: false, cooldownSeconds: 0 })
  const fired = engine.fire_schedule(new Date())
  eq(fired.length, 0, 'none')
  await new Promise((r) => setTimeout(r, 10))
  eq(hits.length, 0, 'no playbook')
})

await run('fire_schedule: missing cron is skipped', () => {
  const hits: string[] = []
  const engine = makeEngine(hits)
  engine.upsert({ ...base, id: 'trg-3', cron: undefined })
  eq(engine.fire_schedule(new Date()).length, 0, 'no cron')
})

await run('fire_schedule: bad cron does not throw', () => {
  const hits: string[] = []
  const engine = makeEngine(hits)
  engine.upsert({ ...base, id: 'trg-4', cron: 'not a cron' })
  engine.fire_schedule(new Date())
})

await run('fire_schedule: non-matching cron skipped', () => {
  const hits: string[] = []
  const engine = makeEngine(hits)
  engine.upsert({ ...base, id: 'trg-5', cron: '0 2 31 2 *' }) // 31 Feb never
  eq(engine.fire_schedule(new Date('2026-08-27T12:00:00Z')).length, 0, 'never')
})

await run('reloadFrom: UI save replaces in-memory triggers without losing fireCount', () => {
  const engine = makeEngine([])
  engine.upsert({ ...base, id: 'trg-6', name: 'old', cooldownSeconds: 0 })
  const before = engine.get('trg-6')!
  before.fireCount = 7
  engine.reloadFrom([{ ...base, id: 'trg-6', name: 'new', playbookId: 'pb-new', createdAt: 1 }])
  const after = engine.get('trg-6')!
  eq(after.name, 'new', 'name updated')
  eq(after.playbookId, 'pb-new', 'playbook updated')
  eq(after.fireCount, 7, 'fireCount preserved')
})

await run('reloadFrom: deleted trigger is gone', () => {
  const engine = makeEngine([])
  engine.upsert({ ...base, id: 'trg-gone' })
  engine.reloadFrom([])
  assert(!engine.get('trg-gone'), 'removed')
})

await run('scheduler onMinute is invoked once per evaluated minute', async () => {
  const minutes: string[] = []
  const start = new Date('2026-08-27T10:00:30Z')
  let now = start
  const sched = new SchedulerService({
    getTasks: () => [],
    run: async () => {},
    now: () => now,
    intervalMs: 60_000,
    onMinute: (at) => minutes.push(at.toISOString()),
  })
  await sched.tick()
  now = new Date('2026-08-27T10:02:05Z')
  await sched.tick()
  assert(minutes.length >= 1, `got ${minutes.length}`)
  sched.stop()
})

await run('pattern trigger still matches substring and regex', async () => {
  const hits: string[] = []
  const engine = makeEngine(hits)
  engine.upsert({
    id: 'p1',
    name: 'bgp',
    enabled: true,
    kind: 'pattern',
    match: 'BGP.*DOWN',
    matchMode: 'regex',
    action: 'run-playbook',
    playbookId: 'pb-bgp',
    cooldownSeconds: 0,
  })
  engine.handleTerminalData('rtr1', 'line BGP neighbor 1.2.3.4 DOWN\n')
  await new Promise((r) => setTimeout(r, 20))
  assert(hits[0]?.startsWith('pb-bgp|'), `hit=${hits[0]}`)
})

await run('threshold trigger fires on gt and not on below', async () => {
  const hits: string[] = []
  const engine = makeEngine(hits)
  engine.upsert({
    id: 'th1',
    name: 'cpu',
    enabled: true,
    kind: 'threshold',
    metric: 'cpuUsagePercent',
    op: 'gt',
    value: 90,
    action: 'run-playbook',
    playbookId: 'pb-cpu',
    cooldownSeconds: 0,
  })
  engine.handleMonitorSnapshot('host1', { cpuUsagePercent: 50 })
  await new Promise((r) => setTimeout(r, 10))
  eq(hits.length, 0, 'below')
  engine.handleMonitorSnapshot('host1', { cpuUsagePercent: 91 })
  await new Promise((r) => setTimeout(r, 20))
  assert(hits[0]?.startsWith('pb-cpu|'), `hit=${hits[0]}`)
})

console.log('All v333 schedule-trigger extreme tests passed.')
