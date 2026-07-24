import { SessionRecorder, toAsciinema, fromAsciinema, type Recording } from './sessionRecorder'

const cases: Array<{ name: string; run: () => void | Promise<void> }> = []
function test(n: string, r: () => void | Promise<void>) { cases.push({ name: n, run: r }) }
function eq(a: unknown, b: unknown, m = '') { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`) }
function ok(v: unknown, m = '') { if (!v) throw new Error(m || 'expected truthy') }
function throws(fn: () => void, m = '') { let t = false; try { fn() } catch { t = true } if (!t) throw new Error(m || 'expected throw') }

// ─── record + relative timestamps ───
test('start/record/stop captures events with relative t', () => {
  let t = 10_000
  const r = new SessionRecorder({ now: () => t })
  const id = r.start('term-1', { width: 120, height: 40, title: 'deploy' })
  r.out(id, 'hello', 11_000) // +1s
  r.out(id, 'world', 13_500) // +3.5s
  t = 14_000
  const rec = r.stop(id)
  eq(rec.events.length, 2)
  eq(rec.events[0].t, 1)
  eq(rec.events[1].t, 3.5)
  eq(rec.width, 120)
  eq(rec.title, 'deploy')
})
test('record before start t clamps to 0', () => {
  const r = new SessionRecorder({ now: () => 5000 })
  const id = r.start('t')
  r.out(id, 'x', 4000) // before start
  eq(r.get(id)!.events[0].t, 0)
})
test('record on unknown id throws', () => {
  const r = new SessionRecorder()
  throws(() => r.out('nope', 'x'))
})
test('record after stop throws', () => {
  const r = new SessionRecorder({ now: () => 0 })
  const id = r.start('t')
  r.stop(id)
  throws(() => r.out(id, 'x'))
})
test('event limit enforced', () => {
  const r = new SessionRecorder({ now: () => 0, eventLimit: 2 })
  const id = r.start('t')
  r.out(id, 'a'); r.out(id, 'b')
  throws(() => r.out(id, 'c'))
})

// ─── list / get / delete ───
test('list returns metadata sorted by start time', () => {
  let t = 0
  const r = new SessionRecorder({ now: () => t })
  t = 2000; const b = r.start('term-b')
  t = 1000; const a = r.start('term-a')
  const l = r.list()
  eq(l[0].id, a)
  eq(l[1].id, b)
  ok(r.delete(a))
  eq(r.list().length, 1)
})

// ─── replay / scrub ───
test('replay returns events from fromSec with rebased t', () => {
  const r = new SessionRecorder({ now: () => 0 })
  const id = r.start('t')
  r.out(id, 'a', 1000)
  r.out(id, 'b', 2000)
  r.out(id, 'c', 3000)
  const all = r.replay(id)
  eq(all.length, 3)
  const scrubbed = r.replay(id, { fromSec: 2 }) // includes b(2s),c(3s)
  eq(scrubbed.length, 2)
  eq(scrubbed[0].data, 'b')
  eq(scrubbed[0].t, 0) // rebased
  eq(scrubbed[1].data, 'c')
  eq(scrubbed[1].t, 1)
})
test('replay with durationSec window', () => {
  const r = new SessionRecorder({ now: () => 0 })
  const id = r.start('t')
  r.out(id, 'a', 1000); r.out(id, 'b', 2000); r.out(id, 'c', 3000)
  const win = r.replay(id, { fromSec: 0.5, durationSec: 2 }) // t in [0.5,2.5) → a,b
  eq(win.map((e) => e.data), ['a', 'b'])
})
test('replay unknown id throws', () => {
  const r = new SessionRecorder()
  throws(() => r.replay('nope'))
})

// ─── asciinema export / import ───
function sampleRec(): Recording {
  return {
    id: 'r1', terminalId: 't', title: 'demo', startedAt: 1700000000000,
    width: 100, height: 30,
    events: [
      { t: 0.5, kind: 'out', data: 'ls\r\n' },
      { t: 1.0, kind: 'in', data: 'ls' },
      { t: 2.0, kind: 'resize', data: '120x40' },
    ],
  }
}
test('toAsciinema emits v2 header + event rows', () => {
  const cast = toAsciinema(sampleRec())
  const lines = cast.trim().split('\n')
  const header = JSON.parse(lines[0])
  eq(header.version, 2)
  eq(header.width, 100)
  eq(header.title, 'demo')
  eq(JSON.parse(lines[1]), [0.5, 'o', 'ls\r\n'])
  eq(JSON.parse(lines[2]), [1, 'i', 'ls'])
  eq(JSON.parse(lines[3]), [2, 'r', '120x40'])
})
test('fromAsciinema round-trips events + maps codes', () => {
  const cast = toAsciinema(sampleRec())
  const rec = fromAsciinema(cast)
  eq(rec.width, 100)
  eq(rec.title, 'demo')
  eq(rec.events.length, 3)
  eq(rec.events[0].kind, 'out')
  eq(rec.events[1].kind, 'in')
  eq(rec.events[2].kind, 'resize')
  eq(rec.startedAt, 1700000000000)
})
test('fromAsciinema rejects empty / bad header / wrong version', () => {
  throws(() => fromAsciinema(''))
  throws(() => fromAsciinema('not json\n'))
  throws(() => fromAsciinema(JSON.stringify({ version: 1 }) + '\n'))
})
test('fromAsciinema tolerates malformed event lines', () => {
  const cast = JSON.stringify({ version: 2, width: 80, height: 24, timestamp: 0 }) + '\n' +
    '[0.5,"o","ok"]\n' + 'garbage\n' + '[1,"o","still ok"]\n'
  const rec = fromAsciinema(cast)
  eq(rec.events.length, 2)
})
test('exportCast on unknown id throws', () => {
  const r = new SessionRecorder()
  throws(() => r.exportCast('nope'))
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
