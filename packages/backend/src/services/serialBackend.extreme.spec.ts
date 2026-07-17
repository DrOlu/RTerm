import { SerialBackend, type SerialPortLike } from './SerialBackend'
import type { BaseConnectionConfig } from '../types'

/**
 * serialBackend.extreme.spec — verifies SerialBackend logic against an injected
 * fake `serialport` module (no real hardware/native module needed).
 */

class FakePort implements SerialPortLike {
  path: string
  opts: any
  handlers: Record<string, ((...a: any[]) => void)[]> = {}
  writes = ''
  closed = false
  constructor(path: string, opts: any) { this.path = path; this.opts = opts }
  on(ev: string, cb: (...a: any[]) => void) { (this.handlers[ev] ||= []).push(cb) }
  emit(ev: string, ...a: any[]) { (this.handlers[ev] || []).forEach((cb) => cb(...a)) }
  write(data: any) { this.writes += typeof data === 'string' ? data : data.toString(); }
  close() { this.closed = true; this.emit('close') }
  set() {}
}

const cases: Array<{ name: string; run: () => Promise<void> }> = []
function test(n: string, r: () => Promise<void>) { cases.push({ name: n, run: r }) }

function fakeCfg(): any {
  return {
    type: 'serial', id: 'ser-1', title: 'console', cols: 80, rows: 24,
    path: '/dev/ttyUSB0', baudRate: 9600, parity: 'none',
  } as BaseConnectionConfig as any
}

test('spawn throws clear error when serialport module is not installed', async () => {
  SerialBackend.setSerialModuleForTest(null)
  const b = new SerialBackend()
  let threw = false
  try { await b.spawn(fakeCfg()) } catch (e: any) {
    threw = true
    if (!/serialport.*not installed/i.test(e.message)) throw new Error(`unexpected msg: ${e.message}`)
  }
  if (!threw) throw new Error('expected throw')
})

test('spawn opens port, emits banner, data forwards via onData', async () => {
  let created: FakePort | null = null
  class FakeSerialCtor { constructor(path: string, opts: any) { created = new FakePort(path, opts); return created as any } }
  SerialBackend.setSerialModuleForTest(FakeSerialCtor as any)
  const b = new SerialBackend()
  const received: string[] = []
  const ptyId = await b.spawn(fakeCfg())
  b.onData(ptyId, (d) => received.push(d))
  created!.emit('open')
  created!.emit('data', Buffer.from('Cisco IOS\r\n'))
  if (!received.join('').includes('Serial connection opened')) throw new Error('banner missing')
  if (!received.join('').includes('Cisco IOS')) throw new Error('data not forwarded')
})

test('write forwards to the port', async () => {
  let created: FakePort | null = null
  class FakeSerialCtor { constructor(path: string, opts: any) { created = new FakePort(path, opts); return created as any } }
  SerialBackend.setSerialModuleForTest(FakeSerialCtor as any)
  const b = new SerialBackend()
  const ptyId = await b.spawn(fakeCfg())
  b.write(ptyId, 'show version\n')
  if (created!.writes !== 'show version\n') throw new Error(`write mismatch: ${created!.writes}`)
})

test('kill closes port + emits onExit(0)', async () => {
  let created: FakePort | null = null
  class FakeSerialCtor { constructor(path: string, opts: any) { created = new FakePort(path, opts); return created as any } }
  SerialBackend.setSerialModuleForTest(FakeSerialCtor as any)
  const b = new SerialBackend()
  let exited = -1
  const ptyId = await b.spawn(fakeCfg())
  b.onExit(ptyId, (c) => { exited = c })
  b.kill(ptyId)
  if (created!.closed !== true) throw new Error('port should be closed')
  if (exited !== 0) throw new Error(`onExit 0, got ${exited}`)
})

test('port error emits onExit(-1)', async () => {
  let created: FakePort | null = null
  class FakeSerialCtor { constructor(path: string, opts: any) { created = new FakePort(path, opts); return created as any } }
  SerialBackend.setSerialModuleForTest(FakeSerialCtor as any)
  const b = new SerialBackend()
  let exited: number | null = null
  const ptyId = await b.spawn(fakeCfg())
  b.onExit(ptyId, (c) => { exited = c })
  created!.emit('error', new Error('permission denied'))
  if (exited !== -1) throw new Error(`expected onExit(-1), got ${exited}`)
})

test('getInitializationState ready after open, undefined before', async () => {
  let created: FakePort | null = null
  class FakeSerialCtor { constructor(path: string, opts: any) { created = new FakePort(path, opts); return created as any } }
  SerialBackend.setSerialModuleForTest(FakeSerialCtor as any)
  const b = new SerialBackend()
  const ptyId = await b.spawn(fakeCfg())
  if (b.getInitializationState(ptyId) !== undefined) throw new Error('before open')
  created!.emit('open')
  if (b.getInitializationState(ptyId) !== 'ready') throw new Error('after open')
})

test('spawn rejects non-serial config', async () => {
  const b = new SerialBackend()
  let threw = false
  try { await b.spawn({ type: 'ssh' } as any) } catch { threw = true }
  if (!threw) throw new Error('expected throw')
})

test('getRemoteOs is undefined (unknown OS over serial)', async () => {
  const b = new SerialBackend()
  if (b.getRemoteOs('any') !== undefined) throw new Error('serial remoteOs should be undefined')
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
