/**
 * compoundingStore.extreme.spec — SQLite occurrence compounding + probes + estate identity.
 */
export {}

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CompoundingStore } from './compoundingStore'
import { extractLessons } from './compoundingKnowledge'

const tests: Array<{ name: string; run: () => Promise<void> | void }> = []
function test(name: string, run: () => Promise<void> | void) {
  tests.push({ name, run })
}
function assertTrue(cond: boolean, message: string): void {
  if (!cond) throw new Error(message)
}
function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message}. expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`)
}

function tmpStore(): { store: CompoundingStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-'))
  const store = new CompoundingStore({ filePath: path.join(dir, 't.sqlite') })
  return { store, dir }
}

test('recordLessons compounds occurrences and keeps one row', () => {
  const { store, dir } = tmpStore()
  const lessons = extractLessons('w:InvalidSelectors from PSRP Receive')
  assertTrue(lessons.length >= 1, 'extractor hit')
  store.recordLessons(lessons, 'run-1')
  store.recordLessons(lessons, 'run-2')
  const rows = store.listLessons()
  const row = rows.find((r) => r.fingerprint === lessons[0].fingerprint)
  assertTrue(!!row, 'row exists')
  assertEqual(row!.occurrences, 2, 'second record increments')
  assertEqual(row!.lastRunId, 'run-2', 'last run updated')
  store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('hasProbe is false until recordProbe', () => {
  const { store, dir } = tmpStore()
  assertTrue(!store.hasProbe('s1', 'ad-join'), 'no probe yet')
  store.recordProbe('s1', 'ad-join', 'SMB blocked', 'nltest /dsgetdc:corp.local', true)
  assertTrue(store.hasProbe('s1', 'ad-join'), 'probe recorded')
  assertTrue(!store.hasProbe('s1', 'smb'), 'other tag still missing')
  store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('estate facts key by connection name not IP', () => {
  const { store, dir } = tmpStore()
  store.upsertEstateFact({ identity: 'CORP-DC1', host: '44.197.31.152', role: 'dc', transport: 'psrp', auth: 'negotiate', domain: 'corp.local' })
  store.upsertEstateFact({ identity: 'neuralos-win1', host: '44.197.31.152', role: 'dc', transport: 'psrp', auth: 'basic' })
  const facts = store.listEstateFacts()
  assertEqual(facts.length, 2, 'two identities on same IP')
  assertTrue(facts.some((f) => f.identity === 'CORP-DC1' && f.auth === 'negotiate'), 'dc1 negotiate')
  assertTrue(facts.some((f) => f.identity === 'neuralos-win1' && f.auth === 'basic'), 'win1 basic')
  store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('goals persist per session', () => {
  const { store, dir } = tmpStore()
  store.upsertGoal({ id: 'g1', sessionId: 's1', text: 'join server-2', status: 'open' })
  store.upsertGoal({ id: 'g1', sessionId: 's1', text: 'join server-2', status: 'blocked', blockedBy: 'winrm_down' })
  const goals = store.listGoals('s1')
  assertEqual(goals.length, 1, 'upsert not insert')
  assertEqual(goals[0].status, 'blocked', 'status updated')
  assertEqual(store.listGoals('other').length, 0, 'session scoped')
  store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('promptBlock includes NEVER lines after a lesson', () => {
  const { store, dir } = tmpStore()
  store.recordLessons(extractLessons('NetUseAdd \\\\DC\\IPC$ returned 64'))
  const block = store.promptBlock()
  assertTrue(/NEVER:/.test(block), 'never-do injected')
  assertTrue(/djoin/.test(block), 'instead mentions djoin')
  store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('store failure does not throw (bad path still constructs via mkdir)', () => {
  const { store, dir } = tmpStore()
  store.close()
  // after close, methods must not throw
  store.recordLessons(extractLessons('w:InvalidSelectors'))
  store.listLessons()
  store.hasProbe('x', 'y')
  fs.rmSync(dir, { recursive: true, force: true })
})

async function main() {
  let failed = 0
  for (const t of tests) {
    try {
      await t.run()
      console.log(`  ok  ${t.name}`)
    } catch (err) {
      failed++
      console.error(`  FAIL  ${t.name}: ${(err as Error).message}`)
    }
  }
  console.log(`# tests ${tests.length}`)
  console.log(`# pass ${tests.length - failed}`)
  console.log(`# fail ${failed}`)
  if (failed) process.exit(1)
}
main()
