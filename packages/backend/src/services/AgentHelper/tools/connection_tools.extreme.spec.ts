import type { SSHConnectionEntry } from '../../../types'
import type { IConnectionManagerRuntime } from '../../runtimeContracts'
import type { ToolExecutionContext } from '../types'
import { manageSshConnection } from './connection_tools'

/**
 * connection_tools.extreme.spec — exercises the manage_ssh_connection agent
 * tool (create/update/delete/list) against an in-memory fake connection
 * manager that mirrors the real ConnectionManager's list semantics.
 */

class FakeConnectionManager implements IConnectionManagerRuntime {
  list: SSHConnectionEntry[] = []
  events: string[] = []

  listSsh(): readonly SSHConnectionEntry[] {
    return this.list
  }

  createSsh(entry: SSHConnectionEntry): SSHConnectionEntry {
    const stored = { ...entry, id: entry.id || `ssh-fake-${this.list.length}` }
    this.list = [...this.list, stored]
    this.events.push(`create:${stored.name}`)
    return stored
  }

  updateSsh(entry: SSHConnectionEntry): SSHConnectionEntry {
    const idx = this.list.findIndex((e) => e.id === entry.id)
    if (idx === -1) throw new Error(`No saved SSH connection with id "${entry.id}" to update.`)
    const next = this.list.slice()
    next[idx] = { ...this.list[idx], ...entry, id: entry.id }
    this.list = next
    this.events.push(`update:${entry.id}`)
    return next[idx]
  }

  deleteSsh(id: string): boolean {
    const before = this.list.length
    this.list = this.list.filter((e) => e.id !== id)
    const removed = this.list.length < before
    if (removed) this.events.push(`delete:${id}`)
    return removed
  }

  // WinRM stubs (not exercised by this spec; satisfy the interface).
  winrmList: import('../../../types').WinRMConnectionEntry[] = []
  listWinrm(): readonly import('../../../types').WinRMConnectionEntry[] { return this.winrmList }
  createWinrm(e: import('../../../types').WinRMConnectionEntry) { this.winrmList = [...this.winrmList, e]; return e }
  updateWinrm(e: import('../../../types').WinRMConnectionEntry) {
    const i = this.winrmList.findIndex((x) => x.id === e.id)
    if (i === -1) throw new Error(`No saved WinRM connection with id "${e.id}" to update.`)
    const n = this.winrmList.slice(); n[i] = { ...this.winrmList[i], ...e }
    this.winrmList = n; return n[i]
  }
  deleteWinrm(id: string): boolean {
    const b = this.winrmList.length
    this.winrmList = this.winrmList.filter((e) => e.id !== id)
    return this.winrmList.length < b
  }
}

function makeContext(
  manager: FakeConnectionManager,
): ToolExecutionContext {
  return {
    sessionId: 's',
    messageId: 'm',
    terminalService: {} as any,
    sendEvent: () => {},
    commandPolicyService: {} as any,
    commandPolicyMode: 'standard',
    connectionManager: manager,
  }
}

const cases: Array<{ name: string; run: () => Promise<void> }> = []

function test(name: string, run: () => Promise<void>) {
  cases.push({ name, run })
}

test('create adds a connection and returns a usable Name', async () => {
  const m = new FakeConnectionManager()
  const ctx = makeContext(m)
  const res = await manageSshConnection(
    { action: 'create', connection: { name: 'core-sw', host: '10.0.0.1', port: 22, username: 'admin', authMethod: 'password', password: 'p', algorithmsPreset: 'cisco', termType: 'vt100' } },
    ctx,
  )
  if (!res.includes('Created saved SSH connection')) throw new Error(`expected Created, got: ${res}`)
  if (m.list.length !== 1) throw new Error(`expected 1 entry, got ${m.list.length}`)
  if (m.list[0].algorithmsPreset !== 'cisco') throw new Error('preset not carried')
  if (m.list[0].termType !== 'vt100') throw new Error('termType not carried')
  if (!res.includes('open_terminal_tab using Name "core-sw"')) throw new Error('missing open hint')
})

test('create rejects duplicate names', async () => {
  const m = new FakeConnectionManager()
  m.list.push({ id: 'x', name: 'dup', host: 'h', port: 22, username: 'u', authMethod: 'password' })
  const res = await manageSshConnection(
    { action: 'create', connection: { name: 'dup', host: 'h2', port: 22, username: 'u2', authMethod: 'password' } },
    makeContext(m),
  )
  if (!res.includes('already exists')) throw new Error(`expected duplicate error, got: ${res}`)
  if (m.list.length !== 1) throw new Error('should not have added a second entry')
})

test('list returns all connections with ids', async () => {
  const m = new FakeConnectionManager()
  m.list.push(
    { id: 'a', name: 'web-1', host: '1.1.1.1', port: 22, username: 'root', authMethod: 'password' },
    { id: 'b', name: 'core', host: '2.2.2.2', port: 22, username: 'admin', authMethod: 'privateKey', algorithmsPreset: 'cisco' },
  )
  const res = await manageSshConnection({ action: 'list' }, makeContext(m))
  if (!res.includes('web-1') || !res.includes('core')) throw new Error(`expected both names, got: ${res}`)
  if (!res.includes('id=a') || !res.includes('id=b')) throw new Error('missing ids')
})

test('list on empty store reports none', async () => {
  const res = await manageSshConnection({ action: 'list' }, makeContext(new FakeConnectionManager()))
  if (!res.includes('No saved SSH connections')) throw new Error(`expected none, got: ${res}`)
})

test('update merges provided fields by id', async () => {
  const m = new FakeConnectionManager()
  m.list.push({ id: 'u1', name: 'old', host: 'h', port: 22, username: 'u', authMethod: 'password', password: 'p' })
  const res = await manageSshConnection(
    { action: 'update', id: 'u1', connection: { name: 'new', host: 'h', port: 22, username: 'u', authMethod: 'password', password: 'p2' } },
    makeContext(m),
  )
  if (!res.includes('Updated saved SSH connection')) throw new Error(`expected Updated, got: ${res}`)
  if (m.list[0].name !== 'new') throw new Error('name not updated')
  if (m.list[0].password !== 'p2') throw new Error('password not updated')
  if (m.events[0] !== 'update:u1') throw new Error('update not delegated to manager')
})

test('update on missing id reports nothing to update', async () => {
  const m = new FakeConnectionManager()
  const res = await manageSshConnection(
    { action: 'update', id: 'nope', connection: { name: 'x', host: 'h', port: 22, username: 'u', authMethod: 'password' } },
    makeContext(m),
  )
  if (!res.includes('No saved SSH connection with id')) throw new Error(`expected missing message, got: ${res}`)
})

test('update without id is rejected', async () => {
  const res = await manageSshConnection(
    { action: 'update', connection: { name: 'x', host: 'h', port: 22, username: 'u', authMethod: 'password' } },
    makeContext(new FakeConnectionManager()),
  )
  if (!res.includes('requires an `id`')) throw new Error(`expected id-required, got: ${res}`)
})

test('delete removes by id', async () => {
  const m = new FakeConnectionManager()
  m.list.push({ id: 'd1', name: 'x', host: 'h', port: 22, username: 'u', authMethod: 'password' })
  const res = await manageSshConnection({ action: 'delete', id: 'd1' }, makeContext(m))
  if (!res.includes('Deleted saved SSH connection')) throw new Error(`expected Deleted, got: ${res}`)
  if (m.list.length !== 0) throw new Error('entry still present')
})

test('delete on missing id reports nothing deleted', async () => {
  const res = await manageSshConnection({ action: 'delete', id: 'ghost' }, makeContext(new FakeConnectionManager()))
  if (!res.includes('nothing deleted')) throw new Error(`expected nothing deleted, got: ${res}`)
})

test('graceful when no connection manager is wired', async () => {
  const ctx = makeContext(new FakeConnectionManager())
  delete (ctx as any).connectionManager
  const res = await manageSshConnection({ action: 'list' }, ctx)
  if (!res.includes('not available in this runtime')) throw new Error(`expected unavailable, got: ${res}`)
})

async function main() {
  let pass = 0
  let fail = 0
  for (const c of cases) {
    try {
      await c.run()
      pass++
      console.log(`PASS ${c.name}`)
    } catch (e: any) {
      fail++
      console.log(`FAIL ${c.name}: ${e?.message ?? e}`)
    }
  }
  console.log(`\n${pass}/${cases.length} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

void main()
