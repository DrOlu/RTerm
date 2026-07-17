import type { WinRMConnectionEntry } from '../../../types'
import type { IConnectionManagerRuntime } from '../../runtimeContracts'
import type { ToolExecutionContext } from '../types'
import { manageWinrmConnection } from './winrm_connection_tools'

class FakeCM implements IConnectionManagerRuntime {
  ssh: any[] = []
  winrm: WinRMConnectionEntry[] = []
  listSsh() { return this.ssh }
  createSsh(e: any) { this.ssh.push(e); return e }
  updateSsh(e: any) { return e }
  deleteSsh() { return false }
  listWinrm() { return this.winrm }
  createWinrm(e: WinRMConnectionEntry) { this.winrm = [...this.winrm, e]; return e }
  updateWinrm(e: WinRMConnectionEntry) {
    const i = this.winrm.findIndex((x) => x.id === e.id)
    if (i === -1) throw new Error(`No saved WinRM connection with id "${e.id}" to update.`)
    const n = this.winrm.slice(); n[i] = { ...this.winrm[i], ...e }
    this.winrm = n; return n[i]
  }
  deleteWinrm(id: string) {
    const b = this.winrm.length
    this.winrm = this.winrm.filter((e) => e.id !== id)
    return this.winrm.length < b
  }
}

function ctx(m: FakeCM): ToolExecutionContext {
  return {
    sessionId: 's', messageId: 'm', terminalService: {} as any, sendEvent: () => {},
    commandPolicyService: {} as any, commandPolicyMode: 'standard', connectionManager: m,
  } as any
}

const cases: Array<{ name: string; run: () => Promise<void> }> = []
function test(n: string, r: () => Promise<void>) { cases.push({ name: n, run: r }) }

test('create adds a winrm connection', async () => {
  const m = new FakeCM()
  const res = await manageWinrmConnection(
    { action: 'create', connection: { name: 'win-srv', host: '10.0.0.5', port: 5985, username: 'Administrator', password: 'p' } },
    ctx(m),
  )
  if (!res.includes('Created saved WinRM connection')) throw new Error(res)
  if (m.winrm.length !== 1 || m.winrm[0].host !== '10.0.0.5') throw new Error('not stored')
})

test('create rejects duplicate names', async () => {
  const m = new FakeCM()
  m.winrm.push({ id: 'x', name: 'dup', host: 'h', port: 5985, username: 'u', password: 'p' })
  const res = await manageWinrmConnection(
    { action: 'create', connection: { name: 'dup', host: 'h2', port: 5985, username: 'u', password: 'p' } },
    ctx(m),
  )
  if (!res.includes('already exists')) throw new Error(res)
})

test('list returns winrm connections', async () => {
  const m = new FakeCM()
  m.winrm.push({ id: 'a', name: 'w1', host: '1.1.1.1', port: 5985, username: 'u', password: 'p' })
  const res = await manageWinrmConnection({ action: 'list' }, ctx(m))
  if (!res.includes('w1') || !res.includes('id=a')) throw new Error(res)
})

test('update merges by id', async () => {
  const m = new FakeCM()
  m.winrm.push({ id: 'u1', name: 'old', host: 'h', port: 5985, username: 'u', password: 'p' })
  const res = await manageWinrmConnection(
    { action: 'update', id: 'u1', connection: { name: 'new', host: 'h', port: 5986, username: 'u', password: 'p2', transport: 'https' } },
    ctx(m),
  )
  if (!res.includes('Updated')) throw new Error(res)
  if (m.winrm[0].name !== 'new' || m.winrm[0].transport !== 'https') throw new Error('not merged')
})

test('delete removes by id', async () => {
  const m = new FakeCM()
  m.winrm.push({ id: 'd1', name: 'x', host: 'h', port: 5985, username: 'u', password: 'p' })
  const res = await manageWinrmConnection({ action: 'delete', id: 'd1' }, ctx(m))
  if (!res.includes('Deleted')) throw new Error(res)
  if (m.winrm.length !== 0) throw new Error('still present')
})

test('graceful when no connection manager', async () => {
  const c = ctx(new FakeCM()); delete (c as any).connectionManager
  const res = await manageWinrmConnection({ action: 'list' }, c)
  if (!res.includes('not available in this runtime')) throw new Error(res)
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
