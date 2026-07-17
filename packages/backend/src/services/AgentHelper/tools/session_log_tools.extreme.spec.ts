import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { SessionLogService } from '../../automation/sessionLogService'
import type { ToolExecutionContext } from '../types'
import { listSessionLogs, readSessionLog } from './session_log_tools'

const cases: Array<{ name: string; run: () => Promise<void> }> = []
function test(n: string, r: () => Promise<void>) { cases.push({ name: n, run: r }) }

function ctxWithLogger(logger?: { list(): any[]; read(id: string): string }): ToolExecutionContext {
  return { sessionId: 's', messageId: 'm', terminalService: {} as any, sendEvent: () => {}, commandPolicyService: {} as any, commandPolicyMode: 'standard', sessionLogger: logger } as any
}

test('list_session_logs returns formatted entries', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rterm-slt-'))
  const svc = new SessionLogService({ logDir: dir })
  svc.start('s1', { title: 'web-1', type: 'ssh' }); svc.write('s1', 'hi'); svc.stop('s1')
  const res = await listSessionLogs({}, ctxWithLogger(svc))
  if (!res.includes('web-1') || !res.includes('s1')) throw new Error(res)
})

test('list_session_logs reports none when empty', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rterm-slt-'))
  const svc = new SessionLogService({ logDir: dir })
  const res = await listSessionLogs({}, ctxWithLogger(svc))
  if (!res.includes('No recorded sessions')) throw new Error(res)
})

test('read_session_log returns content', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rterm-slt-'))
  const svc = new SessionLogService({ logDir: dir })
  svc.start('s2', { title: 'r1', type: 'winrm' }); svc.write('s2', 'hello-log-content'); svc.stop('s2')
  const res = await readSessionLog({ sessionId: 's2' }, ctxWithLogger(svc))
  if (!res.includes('hello-log-content')) throw new Error(res)
  if (!res.includes('<session_log>')) throw new Error('expected wrapped block')
})

test('read_session_log reports missing id', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rterm-slt-'))
  const svc = new SessionLogService({ logDir: dir })
  const res = await readSessionLog({ sessionId: 'ghost' }, ctxWithLogger(svc))
  if (!res.includes('No recorded log')) throw new Error(res)
})

test('list/read without logger report unavailable', async () => {
  const r1 = await listSessionLogs({}, ctxWithLogger(undefined))
  if (!r1.includes('not available')) throw new Error(r1)
  const r2 = await readSessionLog({ sessionId: 'x' }, ctxWithLogger(undefined))
  if (!r2.includes('not available')) throw new Error(r2)
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
