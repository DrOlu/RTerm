import type { SerialConnectionEntry } from '../../../types'
import type { IConnectionManagerRuntime } from '../../runtimeContracts'
import type { ToolExecutionContext } from '../types'
import { manageSerialConnection } from './serial_connection_tools'

class FakeCM implements IConnectionManagerRuntime {
  ssh: any[] = []
  winrm: any[] = []
  serial: SerialConnectionEntry[] = []
  listSsh() { return this.ssh }
  createSsh(e: any) { this.ssh.push(e); return e }
  updateSsh() { return {} as any }
  deleteSsh() { return false }
  listWinrm() { return this.winrm }
  createWinrm(e: any) { this.winrm.push(e); return e }
  updateWinrm() { return {} as any }
  deleteWinrm() { return false }
  listSerial() { return this.serial }
  createSerial(e: SerialConnectionEntry) { this.serial = [...this.serial, e]; return e }
  updateSerial(e: SerialConnectionEntry) {
    const i = this.serial.findIndex((x) => x.id === e.id)
    if (i === -1) throw new Error(`No saved serial connection with id "${e.id}" to update.`)
    const n = this.serial.slice(); n[i] = { ...this.serial[i], ...e }
    this.serial = n; return n[i]
  }
  deleteSerial(id: string) {
    const b = this.serial.length
    this.serial = this.serial.filter((e) => e.id !== id)
    return this.serial.length < b
  }
}

function ctx(m: FakeCM): ToolExecutionContext {
  return { sessionId: 's', messageId: 'm', terminalService: {} as any, sendEvent: () => {}, commandPolicyService: {} as any, commandPolicyMode: 'standard', connectionManager: m } as any
}

const cases: Array<{ name: string; run: () => Promise<void> }> = []
function test(n: string, r: () => Promise<void>) { cases.push({ name: n, run: r }) }

test('create adds a serial connection with defaults', async () => {
  const m = new FakeCM()
  const res = await manageSerialConnection({ action: 'create', connection: { name: 'console', path: '/dev/ttyUSB0', baudRate: 9600 } }, ctx(m))
  if (!res.includes('Created saved serial connection')) throw new Error(res)
  if (m.serial.length !== 1) throw new Error('not stored')
  if (m.serial[0].path !== '/dev/ttyUSB0' || m.serial[0].baudRate !== 9600) throw new Error('fields')
  // dataBits default 8
  if (m.serial[0].dataBits !== 8) throw new Error('dataBits default')
})

test('create rejects duplicate names', async () => {
  const m = new FakeCM()
  m.serial.push({ id: 'x', name: 'dup', path: '/dev/ttyUSB1', baudRate: 115200 })
  const res = await manageSerialConnection({ action: 'create', connection: { name: 'dup', path: '/dev/ttyUSB2', baudRate: 9600 } }, ctx(m))
  if (!res.includes('already exists')) throw new Error(res)
})

test('list returns serial connections', async () => {
  const m = new FakeCM()
  m.serial.push({ id: 'a', name: 'c1', path: '/dev/ttyUSB0', baudRate: 9600 })
  const res = await manageSerialConnection({ action: 'list' }, ctx(m))
  if (!res.includes('c1') || !res.includes('ttyUSB0')) throw new Error(res)
})

test('update merges by id', async () => {
  const m = new FakeCM()
  m.serial.push({ id: 'u1', name: 'old', path: '/dev/ttyUSB0', baudRate: 9600 })
  const res = await manageSerialConnection({ action: 'update', id: 'u1', connection: { name: 'new', path: '/dev/ttyUSB0', baudRate: 115200 } }, ctx(m))
  if (!res.includes('Updated')) throw new Error(res)
  if (m.serial[0].name !== 'new' || m.serial[0].baudRate !== 115200) throw new Error('not merged')
})

test('delete removes by id', async () => {
  const m = new FakeCM()
  m.serial.push({ id: 'd1', name: 'x', path: '/dev/ttyUSB0', baudRate: 9600 })
  const res = await manageSerialConnection({ action: 'delete', id: 'd1' }, ctx(m))
  if (!res.includes('Deleted')) throw new Error(res)
  if (m.serial.length !== 0) throw new Error('still present')
})

test('graceful when no connection manager', async () => {
  const c = ctx(new FakeCM()); delete (c as any).connectionManager
  const res = await manageSerialConnection({ action: 'list' }, c)
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
