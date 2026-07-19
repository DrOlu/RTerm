import { parseCron, matchesCron, nextRunUtc, SchedulerService } from './schedulerService'
import type { ScheduledTaskEntry } from '../../types'

const cases: Array<{ name: string; run: () => void | Promise<void> }> = []
function test(n: string, r: () => void | Promise<void>) { cases.push({ name: n, run: r }) }

test('parseCron wildcard expands to full range', () => {
  const s = parseCron('* * * * *')
  if (s[0].length !== 60) throw new Error(`minute len ${s[0].length}`)
  if (s[1].length !== 24) throw new Error(`hour len ${s[1].length}`)
})

test('parseCron ranges and steps', () => {
  const s = parseCron('0-59/15 * * * *')
  if (s[0].join(',') !== '0,15,30,45') throw new Error(s[0].join(','))
})

test('parseCron list', () => {
  const s = parseCron('0,30 6 * * *')
  if (!s[0].includes(0) || !s[0].includes(30) || s[0].length !== 2) throw new Error('list')
})

test('matchesCron every-minute matches every minute', () => {
  for (let h = 0; h < 24; h++) for (let m = 0; m < 60; m++) {
    if (!matchesCron('* * * * *', new Date(Date.UTC(2026, 0, 1, h, m)))) throw new Error(`miss at ${h}:${m}`)
  }
})

test('matchesCron specific time matches only that minute', () => {
  const due = new Date(Date.UTC(2026, 5, 15, 14, 30, 0))
  if (!matchesCron('30 14 * * *', due)) throw new Error('should match 14:30')
  if (matchesCron('30 14 * * *', new Date(Date.UTC(2026, 5, 15, 14, 31)))) throw new Error('should not match 14:31')
})

test('matchesCron day-of-week (0 and 7 both Sunday)', () => {
  const sun = new Date(Date.UTC(2026, 0, 4, 0, 0)) // 2026-01-04 is Sunday
  if (!matchesCron('0 0 * * 0', sun)) throw new Error('dow 0 sun')
  if (!matchesCron('0 0 * * 7', sun)) throw new Error('dow 7 should also be sun')
})

test('nextRunUtc finds the next minute', () => {
  const after = new Date(Date.UTC(2026, 5, 15, 14, 29, 30))
  const next = nextRunUtc('30 14 * * *', after)
  if (next.getUTCHours() !== 14 || next.getUTCMinutes() !== 30) throw new Error(next.toISOString())
})

test('nextRunUtc rolls to next day', () => {
  const after = new Date(Date.UTC(2026, 5, 15, 15, 0))
  const next = nextRunUtc('0 2 * * *', after) // 02:00 daily
  if (next.getUTCDate() !== 16 || next.getUTCHours() !== 2 || next.getUTCMinutes() !== 0) throw new Error(next.toISOString())
})

test('SchedulerService fires due tasks within a tick window', async () => {
  // Fix: every minute at hour 12, minute 0.
  let calls: number = 0
  let nowMs = Date.UTC(2026, 0, 1, 11, 59, 0)
  const tasks: ScheduledTaskEntry[] = [
    { id: 't1', name: 'noon', cron: '0 12 * * *', enabled: true },
  ]
  const sched = new SchedulerService({
    getTasks: () => tasks,
    run: () => { calls++ },
    now: () => new Date(nowMs),
    intervalMs: 1000,
  })
  // Advance time across the 12:00 boundary.
  nowMs = Date.UTC(2026, 0, 1, 12, 0, 30)
  await sched.tick()
  if (calls !== 1) throw new Error(`expected 1 call, got ${calls}`)
  // Second tick at same time window should not refire (lastTick moved past it).
  await sched.tick()
  if (calls !== 1) throw new Error(`expected still 1, got ${calls}`)
})

test('SchedulerService skips disabled tasks', async () => {
  let calls: number = 0
  const nowMs = Date.UTC(2026, 0, 1, 12, 0, 30)
  const tasks: ScheduledTaskEntry[] = [
    { id: 't1', name: 'noon', cron: '0 12 * * *', enabled: false },
  ]
  const sched = new SchedulerService({ getTasks: () => tasks, run: () => { calls++ }, now: () => new Date(nowMs) })
  await sched.tick()
  if (calls !== 0) throw new Error(`disabled task fired ${calls} times`)
})

test('SchedulerService fires multiple tasks due same minute', async () => {
  let calls: number = 0
  const nowMs = Date.UTC(2026, 0, 1, 12, 0, 30)
  const tasks: ScheduledTaskEntry[] = [
    { id: 'a', name: 'a', cron: '0 12 * * *', enabled: true },
    { id: 'b', name: 'b', cron: '*/1 * * * *', enabled: true },
  ]
  const sched = new SchedulerService({ getTasks: () => tasks, run: () => { calls++ }, now: () => new Date(nowMs) })
  await sched.tick()
  if (calls !== 2) throw new Error(`expected 2 calls, got ${calls}`)
})

test('first tick of a fresh service fires only the current minute (no epoch replay)', async () => {
  // Regression: lastTickMs used to start at 0, so the first tick walked every
  // minute since 1970 — a */1 task would be "due" ~29 million times.
  let calls: number = 0
  const nowMs = Date.UTC(2026, 0, 1, 12, 0, 30)
  const tasks: ScheduledTaskEntry[] = [
    { id: 'a', name: 'a', cron: '*/1 * * * *', enabled: true },
  ]
  const sched = new SchedulerService({ getTasks: () => tasks, run: () => { calls++ }, now: () => new Date(nowMs) })
  await sched.tick()
  if (calls !== 1) throw new Error(`expected exactly 1 firing on first tick, got ${calls}`)
})

test('catch-up after sleep fires each task at most once per tick', async () => {
  // Machine slept for 3 hours: a */1 task has ~180 due minutes in the window,
  // but burst-firing it 180 times in a tight loop is dangerous (non-idempotent
  // commands). It must fire exactly once.
  let calls: number = 0
  let nowMs = Date.UTC(2026, 0, 1, 12, 0, 30)
  const tasks: ScheduledTaskEntry[] = [
    { id: 'a', name: 'a', cron: '*/1 * * * *', enabled: true },
  ]
  const sched = new SchedulerService({ getTasks: () => tasks, run: () => { calls++ }, now: () => new Date(nowMs) })
  await sched.tick() // first tick: current minute only
  if (calls !== 1) throw new Error(`expected 1 firing on first tick, got ${calls}`)
  // Sleep 3 hours, then tick again.
  nowMs += 3 * 60 * 60 * 1000
  await sched.tick()
  const catchUpFirings = calls - 1
  if (catchUpFirings !== 1) throw new Error(`expected exactly 1 catch-up firing after sleep, got ${catchUpFirings}`)
})

test('exact minute-boundary ticks do not double-fire a minute', async () => {
  let calls: number = 0
  let nowMs = Date.UTC(2026, 0, 1, 12, 0, 0) // exactly on the boundary
  const tasks: ScheduledTaskEntry[] = [
    { id: 'a', name: 'a', cron: '*/1 * * * *', enabled: true },
  ]
  const sched = new SchedulerService({ getTasks: () => tasks, run: () => { calls++ }, now: () => new Date(nowMs) })
  await sched.tick() // evaluates 12:00
  if (calls !== 1) throw new Error(`expected 1 firing, got ${calls}`)
  nowMs = Date.UTC(2026, 0, 1, 12, 1, 0) // next tick also exactly on a boundary
  await sched.tick() // must evaluate 12:01 only, not re-fire 12:00
  const total: number = calls
  if (total !== 2) throw new Error(`expected 2 firings total, got ${total}`)
})

test('invalid cron (4 fields) throws', () => {
  let threw = false
  try { parseCron('* * * *') } catch { threw = true }
  if (!threw) throw new Error('expected throw for 4 fields')
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
