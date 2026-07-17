import { ConnectionManager } from './ConnectionManager'
import type { SerialConnectionEntry } from '../types'

function makeManager() {
  let settings: any = {
    connections: { ssh: [], winrm: [], serial: [], proxies: [], tunnels: [] },
    automation: { groups: [], deviceMemory: [], scripts: [], scheduledTasks: [], templates: [] },
  }
  const m = new ConnectionManager({ getSettings: () => settings, setSettings: (p) => { settings = { ...settings, ...p } } })
  return { m, getSettings: () => settings }
}

const cases: Array<{ name: string; run: () => void }> = []
function test(n: string, r: () => void) { cases.push({ name: n, run: r }) }

test('serial: create/list/update/delete + preserves other slices', () => {
  const { m, getSettings } = makeManager()
  // Seed an ssh entry to confirm it survives serial mutations.
  m.createSsh({ id: 'ssh-1', name: 's', host: 'h', port: 22, username: 'u', authMethod: 'password' })
  const s: SerialConnectionEntry = { id: '', name: 'console', path: '/dev/ttyUSB0', baudRate: 9600 }
  const created = m.createSerial(s)
  if (!created.id) throw new Error('id assigned')
  if (m.listSerial().length !== 1) throw new Error('list')
  // ssh preserved
  if (getSettings().connections.ssh.length !== 1) throw new Error('ssh slice not preserved')
  const u = m.updateSerial({ ...created, baudRate: 115200 })
  if (u.baudRate !== 115200) throw new Error('update')
  if (m.deleteSerial(created.id) !== true) throw new Error('delete true')
  if (m.deleteSerial(created.id) !== false) throw new Error('delete false on missing')
})

test('serial: update on missing id throws', () => {
  const { m } = makeManager()
  let threw = false
  try { m.updateSerial({ id: 'nope', name: 'x', path: '/dev/ttyUSB0', baudRate: 9600 }) } catch { threw = true }
  if (!threw) throw new Error('expected throw')
})

function main() {
  let pass = 0, fail = 0
  for (const c of cases) {
    try { c.run(); pass++; console.log(`PASS ${c.name}`) }
    catch (e: any) { fail++; console.log(`FAIL ${c.name}: ${e?.message ?? e}`) }
  }
  console.log(`\n${pass}/${cases.length} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}
void main()
