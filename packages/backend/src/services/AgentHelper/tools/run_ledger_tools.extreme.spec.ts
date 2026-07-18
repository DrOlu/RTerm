import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert'
import { AgentRunLedger } from '../../agentRunLedger'
import { getRunLedger, getRunLedgerSchema } from './run_ledger_tools'

/**
 * run_ledger_tools.extreme.spec — verifies the get_run_ledger agent tool:
 * list/summary/get actions against a real SQLite-backed ledger, missing-ledger
 * and bad-input handling, and the tool_call event emission.
 */
let pass = 0, fail = 0
async function test(n: string, r: () => void | Promise<void>) {
  try { await r(); pass++; console.log(`PASS ${n}`) }
  catch (e: any) { fail++; console.log(`FAIL ${n}: ${e?.message ?? e}`) }
}

function makeCtx(ledger?: AgentRunLedger) {
  const events: any[] = []
  const ctx: any = {
    sessionId: 's-test',
    messageId: 'm-test',
    sendEvent: (_sid: string, ev: any) => events.push(ev),
    agentRunLedger: ledger,
  }
  return { ctx, events }
}

function seededLedger(): AgentRunLedger {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rterm-ledger-tool-'))
  const ledger = new AgentRunLedger({ filePath: path.join(dir, 'runs.sqlite') })
  ledger.startRun({ runId: 'run-ok', sessionId: 's1', inputPreview: 'patch the core routers', startedAt: 1000 })
  ledger.recordUsage('run-ok', { model: 'gpt-4.1', promptTokens: 500, completionTokens: 120, totalTokens: 620 })
  ledger.finishRun('run-ok', 'completed')
  ledger.startRun({ runId: 'run-bad', sessionId: 's2', inputPreview: 'reload everything', startedAt: 2000 })
  ledger.finishRun('run-bad', 'failed', 'connection refused')
  return ledger
}

await test('schema validates actions and optional filters', () => {
  assert.strictEqual(getRunLedgerSchema.parse({ action: 'list' }).limit, undefined)
  assert.strictEqual(getRunLedgerSchema.parse({ action: 'summary', sinceDays: 7 }).sinceDays, 7)
  assert.throws(() => getRunLedgerSchema.parse({ action: 'nope' }), /invalid/i)
})

await test('missing ledger returns a helpful message', async () => {
  const { ctx, events } = makeCtx(undefined)
  const out = await getRunLedger({ action: 'list' }, ctx)
  assert.match(out, /not available/i)
  assert.strictEqual(events[0].toolName, 'get_run_ledger')
})

await test('list shows recent runs with status, tokens, and input preview', async () => {
  const ledger = seededLedger()
  const { ctx } = makeCtx(ledger)
  const out = await getRunLedger({ action: 'list' }, ctx)
  assert.match(out, /run-ok \[completed\]/)
  assert.match(out, /run-bad \[failed\]/)
  assert.match(out, /tokens=500in\/120out/)
  assert.match(out, /patch the core routers/)
  assert.ok(out.indexOf('run-bad') < out.indexOf('run-ok'), 'newest first')
  ledger.close()
})

await test('list filters by status and sessionId', async () => {
  const ledger = seededLedger()
  const { ctx } = makeCtx(ledger)
  const failed = await getRunLedger({ action: 'list', status: 'failed' }, ctx)
  assert.match(failed, /run-bad/)
  assert.ok(!failed.includes('run-ok ['))
  const s1 = await getRunLedger({ action: 'list', sessionId: 's1' }, ctx)
  assert.match(s1, /run-ok/)
  assert.ok(!s1.includes('run-bad'))
  ledger.close()
})

await test('summary aggregates tokens by model with run counts', async () => {
  const ledger = seededLedger()
  const { ctx } = makeCtx(ledger)
  const out = await getRunLedger({ action: 'summary' }, ctx)
  assert.match(out, /2 total — 1 completed, 1 failed, 0 aborted/)
  assert.match(out, /500 prompt in \/ 120 completion out/)
  assert.match(out, /gpt-4\.1: 1 run/)
  ledger.close()
})

await test('get shows one run with its usage events; requires runId', async () => {
  const ledger = seededLedger()
  const { ctx } = makeCtx(ledger)
  const need = await getRunLedger({ action: 'get' }, ctx)
  assert.match(need, /runId is required/)
  const out = await getRunLedger({ action: 'get', runId: 'run-ok' }, ctx)
  assert.match(out, /Run run-ok/)
  assert.match(out, /gpt-4\.1 500 in \/ 120 out \(context=620\)/)
  const missing = await getRunLedger({ action: 'get', runId: 'nope' }, ctx)
  assert.match(missing, /No run with id "nope"/)
  ledger.close()
})

async function main() {
  console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}
await main()
