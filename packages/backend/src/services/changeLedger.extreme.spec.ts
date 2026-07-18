import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ChangeLedger } from './changeLedger'

const cases: Array<{ name: string; run: () => void | Promise<void> }> = []
function test(n: string, r: () => void | Promise<void>) { cases.push({ name: n, run: r }) }
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(`ASSERT: ${msg}`) }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'change-ledger-spec-'))
const file = path.join(tmp, 'changes.sqlite')
const open = () => new ChangeLedger({ filePath: file })

test('createChange inserts a planned row; idempotent on duplicate id', () => {
  const l = open()
  l.createChange({ changeId: 'c1', playbookId: 'pb1', playbookName: 'mop', targetsSnapshot: '["ssh://r1"]', createdAt: 1000 })
  l.createChange({ changeId: 'c1', playbookId: 'pbX', playbookName: 'dup', createdAt: 2000 })
  const got = l.getChange('c1')!
  assert(got.change.status === 'planned', 'status planned')
  assert(got.change.playbookName === 'mop', 'duplicate ignored')
  assert(got.change.createdAt === 1000, 'first createdAt kept')
  l.close()
})

test('approve only from planned; approve stamps approver', () => {
  const l = open()
  l.createChange({ changeId: 'c2', playbookId: 'pb1', playbookName: 'mop' })
  assert(l.approveChange('c2', 'olu', 5000) === true, 'first approve ok')
  assert(l.approveChange('c2', 'eve') === false, 'second approve rejected')
  const c = l.getChange('c2')!.change
  assert(c.status === 'approved' && c.approvedBy === 'olu' && c.approvedAt === 5000, 'approver stamped')
  l.close()
})

test('markExecuting only from approved', () => {
  const l = open()
  l.createChange({ changeId: 'c3', playbookId: 'pb1', playbookName: 'mop' })
  assert(l.markExecuting('c3') === false, 'planned cannot execute')
  l.approveChange('c3')
  assert(l.markExecuting('c3', 7000) === true, 'approved → executing')
  assert(l.markExecuting('c3') === false, 'double execute rejected')
  assert(l.getChange('c3')!.change.startedAt === 7000, 'startedAt stamped')
  l.finishChange('c3', 'committed') // leave no executing row behind for later tests
  l.close()
})

test('finishChange only transitions from executing; terminal states are never overwritten', () => {
  const l = open()
  l.createChange({ changeId: 'c4', playbookId: 'pb1', playbookName: 'mop' })
  l.approveChange('c4')
  l.finishChange('c4', 'committed') // not executing → no-op
  assert(l.getChange('c4')!.change.status === 'approved', 'finish before executing ignored')
  l.markExecuting('c4')
  l.finishChange('c4', 'rolled_back', '1 target failed', 'run-9', 9000)
  let c = l.getChange('c4')!.change
  assert(c.status === 'rolled_back' && c.endedAt === 9000 && c.runId === 'run-9', 'terminal status set')
  l.finishChange('c4', 'committed')
  c = l.getChange('c4')!.change
  assert(c.status === 'rolled_back', 'terminal status never overwritten')
  l.close()
})

test('recordStep appends ordered execute/validate/rollback rows; detail truncated', () => {
  const l = open()
  l.createChange({ changeId: 'c5', playbookId: 'pb1', playbookName: 'mop' })
  l.recordStep({ changeId: 'c5', target: 'r1', stepIndex: 0, stepName: 'one', kind: 'command', phase: 'execute', ok: true, detail: 'x'.repeat(9000), at: 1 })
  l.recordStep({ changeId: 'c5', target: 'r1', stepIndex: 0, kind: 'command', phase: 'validate', ok: false, detail: 'mismatch', at: 2 })
  l.recordStep({ changeId: 'c5', target: 'r1', stepIndex: 0, kind: 'command', phase: 'rollback', ok: true, at: 3 })
  const steps = l.getChange('c5')!.steps
  assert(steps.length === 3, 'three rows')
  assert(steps[0].phase === 'execute' && steps[1].phase === 'validate' && steps[2].phase === 'rollback', 'ordered phases')
  assert(steps[0].detail!.length === 4000, 'detail truncated to 4000')
  assert(steps[1].ok === false && steps[2].ok === true, 'ok flags')
  l.close()
})

test('listChanges filters by status/playbookId, newest first, respects limit', () => {
  const l = open()
  for (let i = 0; i < 8; i++) {
    l.createChange({ changeId: `L${i}`, playbookId: i % 2 ? 'pbA' : 'pbB', playbookName: 'mop', createdAt: 9_000_000_000_000 + i })
  }
  l.approveChange('L7')
  const all = l.listChanges({ limit: 100 })
  assert(all.length >= 8, 'all rows listed')
  assert(all[0].changeId === 'L7', 'newest first')
  const approved = l.listChanges({ status: 'approved' })
  assert(approved.length >= 1 && approved.some((c) => c.changeId === 'L7') && approved.every((c) => c.status === 'approved'), 'status filter')
  const pbA = l.listChanges({ playbookId: 'pbA', limit: 100 })
  assert(pbA.length === 4 && pbA.every((c) => c.playbookId === 'pbA'), 'playbook filter')
  const limited = l.listChanges({ limit: 3 })
  assert(limited.length === 3, 'limit respected')
  l.close()
})

test('markStaleChangesAborted closes only executing rows', () => {
  const l = open()
  l.createChange({ changeId: 's1', playbookId: 'pb1', playbookName: 'mop' })
  l.approveChange('s1')
  l.markExecuting('s1')
  l.createChange({ changeId: 's2', playbookId: 'pb1', playbookName: 'mop' }) // stays planned
  const n = l.markStaleChangesAborted(12345)
  assert(n === 1, 'one executing row aborted')
  assert(l.getChange('s1')!.change.status === 'aborted', 'executing → aborted')
  assert(l.getChange('s2')!.change.status === 'planned', 'planned untouched')
  l.close()
})

test('durability: records survive close + reopen (new process simulation)', () => {
  let l = open()
  l.createChange({ changeId: 'd1', playbookId: 'pb1', playbookName: 'mop' })
  l.approveChange('d1', 'olu')
  l.markExecuting('d1')
  l.recordStep({ changeId: 'd1', target: 'r1', stepIndex: 0, kind: 'command', phase: 'execute', ok: true })
  l.finishChange('d1', 'committed')
  l.close()
  l = open()
  const got = l.getChange('d1')!
  assert(got.change.status === 'committed', 'status durable')
  assert(got.change.approvedBy === 'olu', 'approver durable')
  assert(got.steps.length === 1 && got.steps[0].phase === 'execute', 'steps durable')
  l.close()
})

test('best-effort: recordStep for unknown changeId is swallowed, close is idempotent', () => {
  const l = open()
  l.recordStep({ changeId: 'nope', target: 'r1', stepIndex: 0, kind: 'command', phase: 'execute', ok: true }) // FK violation internally
  assert(l.getChange('nope') === undefined, 'no phantom row created')
  l.close()
  l.close() // no throw
})

// --- runner ---
;(async () => {
  let pass = 0
  const failed: string[] = []
  for (const c of cases) {
    try {
      await c.run()
      pass++
      console.log(`PASS ${c.name}`)
    } catch (e) {
      failed.push(c.name)
      console.log(`FAIL ${c.name}: ${e instanceof Error ? e.message : e}`)
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true })
  console.log(`\n${pass}/${cases.length} passed`)
  if (failed.length) process.exit(1)
})()
