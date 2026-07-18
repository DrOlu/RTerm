import assert from 'node:assert'
import { TerminalService } from './TerminalService'

/**
 * writeBroadcast.extreme.spec — verifies TerminalService.writeBroadcast fans
 * input out to every writable terminal in the target set, skips dead/unknown
 * terminals, and never throws on a partially-dead group.
 */
let pass = 0, fail = 0
function test(n: string, r: () => void) {
  try { r(); pass++; console.log(`PASS ${n}`) }
  catch (e: any) { fail++; console.log(`FAIL ${n}: ${e?.message ?? e}`) }
}

type FakeBackend = { writes: Array<{ ptyId: string; data: string }>; write(p: string, d: string): void }

function makeService() {
  const svc = new TerminalService() as any
  const writes: Array<{ ptyId: string; data: string }> = []
  const fakeBackend: FakeBackend = {
    writes,
    write(ptyId: string, data: string) { writes.push({ ptyId, data }) },
  }
  // Point every connection type at the same fake backend.
  for (const t of ['local', 'ssh', 'winrm', 'serial']) svc.backends.set(t, fakeBackend)
  const addTerminal = (id: string, ptyId: string, runtimeState: string, type = 'ssh') => {
    svc.terminals.set(id, { id, ptyId, type, runtimeState, title: id, capabilities: {} })
  }
  return { svc, writes, addTerminal }
}

test('writeBroadcast writes the same data to every ready member', () => {
  const { svc, writes, addTerminal } = makeService()
  addTerminal('a', 'pty-a', 'ready')
  addTerminal('b', 'pty-b', 'ready')
  addTerminal('c', 'pty-c', 'ready')
  const written = svc.writeBroadcast(['a', 'b', 'c'], 'reload\n')
  assert.deepStrictEqual(written, ['a', 'b', 'c'])
  assert.strictEqual(writes.length, 3)
  assert.ok(writes.every((w) => w.data === 'reload\n'))
  assert.deepStrictEqual(writes.map((w) => w.ptyId).sort(), ['pty-a', 'pty-b', 'pty-c'])
})

test('writeBroadcast skips unknown terminal ids without throwing', () => {
  const { svc, writes, addTerminal } = makeService()
  addTerminal('a', 'pty-a', 'ready')
  const written = svc.writeBroadcast(['a', 'ghost', 'phantom'], 'x')
  assert.deepStrictEqual(written, ['a'])
  assert.strictEqual(writes.length, 1)
})

test('writeBroadcast skips non-ready (exited) terminals', () => {
  const { svc, writes, addTerminal } = makeService()
  addTerminal('live', 'pty-live', 'ready')
  addTerminal('dead', 'pty-dead', 'exited')
  const written = svc.writeBroadcast(['live', 'dead'], 'x')
  assert.deepStrictEqual(written, ['live'])
  assert.strictEqual(writes.length, 1)
  assert.strictEqual(writes[0].ptyId, 'pty-live')
})

test('writeBroadcast on an empty target list is a no-op', () => {
  const { svc, writes } = makeService()
  const written = svc.writeBroadcast([], 'x')
  assert.deepStrictEqual(written, [])
  assert.strictEqual(writes.length, 0)
})

test('writeBroadcast handles mixed connection types through their own backends', () => {
  const svc = new TerminalService() as any
  const byType: Record<string, Array<{ ptyId: string; data: string }>> = { ssh: [], winrm: [] }
  svc.backends.set('ssh', { write: (p: string, d: string) => byType.ssh.push({ ptyId: p, data: d }) })
  svc.backends.set('winrm', { write: (p: string, d: string) => byType.winrm.push({ ptyId: p, data: d }) })
  svc.terminals.set('router', { id: 'router', ptyId: 'p1', type: 'ssh', runtimeState: 'ready', title: 'router', capabilities: {} })
  svc.terminals.set('server', { id: 'server', ptyId: 'p2', type: 'winrm', runtimeState: 'ready', title: 'server', capabilities: {} })
  const written = svc.writeBroadcast(['router', 'server'], 'hostname\n')
  assert.deepStrictEqual(written, ['router', 'server'])
  assert.strictEqual(byType.ssh.length, 1)
  assert.strictEqual(byType.winrm.length, 1)
})

console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
