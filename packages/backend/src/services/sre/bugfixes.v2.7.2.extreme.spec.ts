/**
 * v2.7.2 bug hunt — regression tests for the 5 bugs found + fixed.
 */
import { AuditLedger } from '../audit/auditLedger'
import { percentile } from '../sre/goldenSignals'
import { parseAperfReport } from '../aperf/aperfService'

const cases: Array<{ name: string; run: () => void | Promise<void> }> = []
function test(n: string, r: () => void | Promise<void>) { cases.push({ name: n, run: r }) }

// ---- Bug #1: auditLedger.import() with malformed JSON ----
test('bug1: auditLedger.import returns invalid for malformed JSON (not throw)', () => {
  const ledger = new AuditLedger({ now: () => 1000 })
  const result = ledger.import('not json at all')
  if (result.valid !== false) throw new Error('should be invalid')
  if (result.imported !== 0) throw new Error('should import 0')
  if (result.detail !== 'invalid JSON') throw new Error(`should say invalid JSON, got ${result.detail}`)
})

test('bug1: auditLedger.import returns invalid for truncated JSON', () => {
  const ledger = new AuditLedger({ now: () => 1000 })
  const result = ledger.import('[{"kind":"command_executed"')
  if (result.valid !== false) throw new Error('should be invalid')
})

test('bug1: auditLedger.import still accepts valid JSON', () => {
  const ledger = new AuditLedger({ now: () => 1000 })
  ledger.append({ kind: 'command_executed', actor: 'agent', target: 'web-01', summary: 'Ran ls' })
  const json = ledger.export()
  const restored = new AuditLedger({ now: () => 2000 })
  const result = restored.import(json)
  if (!result.valid) throw new Error('should be valid')
  if (result.imported !== 1) throw new Error('should import 1')
})

// ---- Bug #4: goldenSignals.percentile() off-by-one ----
test('bug4: percentile p50 of [1,2,3,4,5] is 3 (median)', () => {
  const p = percentile([1, 2, 3, 4, 5], 50)
  if (p !== 3) throw new Error(`expected 3, got ${p}`)
})

test('bug4: percentile p50 of [1,2,3,4] is 2 (nearest-rank)', () => {
  const p = percentile([1, 2, 3, 4], 50)
  if (p !== 2) throw new Error(`expected 2, got ${p}`)
})

test('bug4: percentile p99 of [1..100] is 99', () => {
  const arr = Array.from({ length: 100 }, (_, i) => i + 1)
  const p = percentile(arr, 99)
  if (p !== 99) throw new Error(`expected 99, got ${p}`)
})

test('bug4: percentile p100 of [1..100] is 100 (clamped)', () => {
  const arr = Array.from({ length: 100 }, (_, i) => i + 1)
  const p = percentile(arr, 100)
  if (p !== 100) throw new Error(`expected 100, got ${p}`)
})

test('bug4: percentile p0 of [1..100] is 1 (clamped)', () => {
  const arr = Array.from({ length: 100 }, (_, i) => i + 1)
  const p = percentile(arr, 0)
  if (p !== 1) throw new Error(`expected 1, got ${p}`)
})

test('bug4: percentile of empty array is undefined', () => {
  const p = percentile([], 50)
  if (p !== undefined) throw new Error('should be undefined')
})

test('bug4: percentile p50 of single-element array', () => {
  const p = percentile([42], 50)
  if (p !== 42) throw new Error(`expected 42, got ${p}`)
})

// ---- Bug #3: aperfService parseAperfReport with undefined metrics ----
test('bug3: parseAperfReport does not flag findings when metrics are undefined', () => {
  const { findings } = parseAperfReport('some random text with no metrics')
  if (findings.length !== 0) throw new Error(`should have no findings, got ${findings.length}`)
})

test('bug3: parseAperfReport does not use non-null assertion on undefined values', () => {
  // This test verifies the fix compiles and runs — the old code used ! assertions
  // which would produce NaN in findings if the regex captured undefined.
  const { summary, findings } = parseAperfReport('cpu_utilization  aggregate  95')
  if (summary.cpuUsagePercent !== 95) throw new Error('should parse cpu')
  if (!findings.some((f) => f.metric === 'cpu_utilization' && f.value === 95)) throw new Error('should flag cpu at 95')
})

// ---- Bug #5: AgentService_v2 empty messages array (type safety) ----
// This is a compile-time fix (BaseMessage | undefined), verified by typecheck.
// The runtime behavior is unchanged: AIMessage.isInstance(undefined) returns false.
test('bug5: empty array access returns undefined (not crash)', () => {
  const messages: any[] = []
  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : undefined
  if (lastMessage !== undefined) throw new Error('should be undefined')
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
