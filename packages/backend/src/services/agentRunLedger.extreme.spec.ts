import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert'
import { AgentRunLedger, extractUsageTokenBreakdown } from './agentRunLedger'

/**
 * agentRunLedger.extreme.spec — verifies the persisted run-audit + token-cost
 * ledger: lifecycle recording, usage aggregation, filtering, summaries, stale
 * run cleanup, restart persistence, and provider usage-shape extraction.
 */
let pass = 0, fail = 0
async function test(n: string, r: () => void | Promise<void>) {
  try { await r(); pass++; console.log(`PASS ${n}`) }
  catch (e: any) { fail++; console.log(`FAIL ${n}: ${e?.message ?? e}`) }
}

function tmpLedger(): { ledger: AgentRunLedger; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rterm-ledger-'))
  const file = path.join(dir, 'runs.sqlite')
  return { ledger: new AgentRunLedger({ filePath: file }), file }
}

await test('extractUsageTokenBreakdown handles OpenAI shape', () => {
  const r = extractUsageTokenBreakdown({ prompt_tokens: 120, completion_tokens: 45, total_tokens: 165 })
  assert.deepStrictEqual(r, { promptTokens: 120, completionTokens: 45 })
})

await test('extractUsageTokenBreakdown handles Anthropic shape', () => {
  const r = extractUsageTokenBreakdown({ input_tokens: 200, output_tokens: 60 })
  assert.deepStrictEqual(r, { promptTokens: 200, completionTokens: 60 })
})

await test('extractUsageTokenBreakdown tolerates garbage', () => {
  assert.deepStrictEqual(extractUsageTokenBreakdown(null), { promptTokens: 0, completionTokens: 0 })
  assert.deepStrictEqual(extractUsageTokenBreakdown({ prompt_tokens: 'x', completion_tokens: -3 }), { promptTokens: 0, completionTokens: 0 })
  assert.deepStrictEqual(extractUsageTokenBreakdown(undefined), { promptTokens: 0, completionTokens: 0 })
})

await test('startRun + finishRun records a complete lifecycle', () => {
  const { ledger } = tmpLedger()
  ledger.startRun({ runId: 'r1', sessionId: 's1', profileId: 'p1', inputPreview: 'check bgp on all routers' })
  ledger.finishRun('r1', 'completed')
  const got = ledger.getRun('r1')
  assert.ok(got, 'run should exist')
  assert.strictEqual(got.run.status, 'completed')
  assert.strictEqual(got.run.sessionId, 's1')
  assert.strictEqual(got.run.inputPreview, 'check bgp on all routers')
  assert.ok(got.run.endedAt! >= got.run.startedAt, 'ended after started')
  ledger.close()
})

await test('recordUsage aggregates prompt/completion tokens and keeps last total', () => {
  const { ledger } = tmpLedger()
  ledger.startRun({ runId: 'r2', sessionId: 's1' })
  ledger.recordUsage('r2', { model: 'gpt-4.1', promptTokens: 1000, completionTokens: 200, totalTokens: 1200 })
  ledger.recordUsage('r2', { model: 'gpt-4.1', promptTokens: 1500, completionTokens: 300, totalTokens: 3000 })
  const got = ledger.getRun('r2')!
  assert.strictEqual(got.run.promptTokens, 2500)
  assert.strictEqual(got.run.completionTokens, 500)
  assert.strictEqual(got.run.lastTotalTokens, 3000, 'last total, not summed')
  assert.strictEqual(got.run.usageEvents, 2)
  assert.strictEqual(got.run.model, 'gpt-4.1')
  assert.strictEqual(got.usage.length, 2)
  assert.strictEqual(got.usage[1].totalTokens, 3000)
  ledger.close()
})

await test('finishRun is terminal — a second finish does not overwrite', () => {
  const { ledger } = tmpLedger()
  ledger.startRun({ runId: 'r3', sessionId: 's1' })
  ledger.finishRun('r3', 'failed', 'model blew up')
  ledger.finishRun('r3', 'completed')
  const got = ledger.getRun('r3')!
  assert.strictEqual(got.run.status, 'failed')
  assert.strictEqual(got.run.error, 'model blew up')
  ledger.close()
})

await test('startRun is idempotent per runId', () => {
  const { ledger } = tmpLedger()
  ledger.startRun({ runId: 'r4', sessionId: 's1', inputPreview: 'first' })
  ledger.startRun({ runId: 'r4', sessionId: 's1', inputPreview: 'second' })
  const got = ledger.getRun('r4')!
  assert.strictEqual(got.run.inputPreview, 'first', 'INSERT OR IGNORE keeps the original row')
  ledger.close()
})

await test('listRuns returns newest first and honors status/session filters', () => {
  const { ledger } = tmpLedger()
  ledger.startRun({ runId: 'ra', sessionId: 'sA', startedAt: 1000 })
  ledger.startRun({ runId: 'rb', sessionId: 'sB', startedAt: 2000 })
  ledger.startRun({ runId: 'rc', sessionId: 'sA', startedAt: 3000 })
  ledger.finishRun('ra', 'completed')
  ledger.finishRun('rb', 'failed', 'x')
  const all = ledger.listRuns()
  assert.deepStrictEqual(all.map((r) => r.runId), ['rc', 'rb', 'ra'])
  const failed = ledger.listRuns({ status: 'failed' })
  assert.deepStrictEqual(failed.map((r) => r.runId), ['rb'])
  const sA = ledger.listRuns({ sessionId: 'sA' })
  assert.deepStrictEqual(sA.map((r) => r.runId), ['rc', 'ra'])
  const limited = ledger.listRuns({ limit: 2 })
  assert.strictEqual(limited.length, 2)
  ledger.close()
})

await test('summarize aggregates run counts and tokens, grouped by model', () => {
  const { ledger } = tmpLedger()
  ledger.startRun({ runId: 'm1', sessionId: 's1', startedAt: 5000 })
  ledger.recordUsage('m1', { model: 'gpt-4.1', promptTokens: 100, completionTokens: 10 })
  ledger.finishRun('m1', 'completed')
  ledger.startRun({ runId: 'm2', sessionId: 's1', startedAt: 6000 })
  ledger.recordUsage('m2', { model: 'claude-opus', promptTokens: 300, completionTokens: 90 })
  ledger.recordUsage('m2', { model: 'claude-opus', promptTokens: 700, completionTokens: 100 })
  ledger.finishRun('m2', 'failed', 'boom')
  const sum = ledger.summarize()
  assert.strictEqual(sum.totalRuns, 2)
  assert.strictEqual(sum.completedRuns, 1)
  assert.strictEqual(sum.failedRuns, 1)
  assert.strictEqual(sum.promptTokens, 1100)
  assert.strictEqual(sum.completionTokens, 200)
  assert.strictEqual(sum.byModel[0].model, 'claude-opus', 'largest token consumer first')
  assert.strictEqual(sum.byModel[0].promptTokens, 1000)
  const since = ledger.summarize({ sinceMs: 5500 })
  assert.strictEqual(since.totalRuns, 1, 'since filter excludes older runs')
  assert.strictEqual(since.promptTokens, 1000)
  ledger.close()
})

await test('ledger persists across reopen (restart durability)', () => {
  const { ledger, file } = tmpLedger()
  ledger.startRun({ runId: 'persist', sessionId: 's1', inputPreview: 'audit me' })
  ledger.recordUsage('persist', { model: 'gpt-4.1', promptTokens: 42, completionTokens: 7 })
  ledger.finishRun('persist', 'completed')
  ledger.close()
  const reopened = new AgentRunLedger({ filePath: file })
  const got = reopened.getRun('persist')!
  assert.strictEqual(got.run.status, 'completed')
  assert.strictEqual(got.run.promptTokens, 42)
  assert.strictEqual(got.usage.length, 1)
  reopened.close()
})

await test('markStaleRunsAborted closes runs orphaned by a crash', () => {
  const { ledger } = tmpLedger()
  ledger.startRun({ runId: 'stale', sessionId: 's1', startedAt: 1000 })
  ledger.startRun({ runId: 'fresh', sessionId: 's1', startedAt: Date.now() })
  const closed = ledger.markStaleRunsAborted(5000)
  assert.strictEqual(closed, 1)
  assert.strictEqual(ledger.getRun('stale')!.run.status, 'aborted')
  assert.strictEqual(ledger.getRun('stale')!.run.error, 'process exited before run finished')
  assert.strictEqual(ledger.getRun('fresh')!.run.status, 'running')
  ledger.close()
})

await test('unknown runId operations are safe no-ops', () => {
  const { ledger } = tmpLedger()
  ledger.recordUsage('ghost', { promptTokens: 5 })
  ledger.finishRun('ghost', 'completed')
  assert.strictEqual(ledger.getRun('ghost'), null)
  ledger.close()
})

async function main() {
  console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}
await main()
