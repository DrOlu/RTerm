import { TerminalService } from '../TerminalService'
import { SessionRecorder } from './sessionRecorder'

const cases: Array<{ name: string; run: () => void | Promise<void> }> = []
function test(n: string, r: () => void | Promise<void>) { cases.push({ name: n, run: r }) }
function ok(v: unknown, m = '') { if (!v) throw new Error(m || 'expected truthy') }
function eq(a: unknown, b: unknown, m = '') { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`) }

function makeService(): { ts: TerminalService; rec: SessionRecorder } {
  const rec = new SessionRecorder()
  const ts = new TerminalService()
  ts.setSessionRecorder(rec)
  return { ts, rec }
}

test('TerminalService routes live output into an active recording', () => {
  const { ts, rec } = makeService()
  const rid = ts.startRecording('term-1', { title: 'demo' })
  ok(rec.get(rid), 'recording exists')
  // simulate terminal output via the private funnel
  ;(ts as unknown as { handleData: (t: string, d: string) => void }).handleData('term-1', 'hello world\n')
  const events = rec.get(rid)!.events
  eq(events.length, 1)
  eq(events[0].kind, 'out')
  ok(events[0].data.includes('hello world'), 'output captured in recording')
})

test('stopRecording ends capture (no more events recorded)', () => {
  const { ts, rec } = makeService()
  const rid = ts.startRecording('term-1')
  ;(ts as unknown as { handleData: (t: string, d: string) => void }).handleData('term-1', 'before\n')
  ts.stopRecording('term-1')
  ;(ts as unknown as { handleData: (t: string, d: string) => void }).handleData('term-1', 'after\n')
  eq(rec.get(rid)!.events.length, 1) // only "before"
  eq(ts.isRecording('term-1'), false)
})

test('isRecording reflects active state', () => {
  const { ts } = makeService()
  eq(ts.isRecording('term-1'), false)
  ts.startRecording('term-1')
  eq(ts.isRecording('term-1'), true)
  ts.stopRecording('term-1')
  eq(ts.isRecording('term-1'), false)
})

test('stopRecording returns the recordingId (null when not recording)', () => {
  const { ts } = makeService()
  const rid = ts.startRecording('term-1')
  eq(ts.stopRecording('term-1'), rid)
  eq(ts.stopRecording('term-1'), null)
})

test('startRecording without a wired recorder throws', () => {
  const ts = new TerminalService() // no setSessionRecorder
  let threw = false
  try { ts.startRecording('term-1') } catch { threw = true }
  ok(threw)
})

test('captured output replays with timing', () => {
  const { ts, rec } = makeService()
  const rid = ts.startRecording('term-1')
  const funnel = ts as unknown as { handleData: (t: string, d: string) => void }
  funnel.handleData('term-1', 'line1\n')
  funnel.handleData('term-1', 'line2\n')
  ts.stopRecording('term-1')
  const replay = rec.replay(rid)
  eq(replay.length, 2)
  ok(replay[0].t <= replay[1].t, 'ordered by time')
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
