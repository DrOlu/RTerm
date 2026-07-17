import type { ToolExecutionContext } from '../types'
import { AutomationManager } from '../../automation/AutomationManager'
import {
  manageDeviceMemory, manageScript, manageGroup, manageScheduledTask, manageTemplate, importPutty,
} from './automation_tools'

// Reuse the FakeConnectionManager from the winrm spec by re-declaring a minimal one here
// (avoid cross-spec imports of a spec file).
class FakeCM {
  ssh: any[] = []
  winrm: any[] = []
  listSsh() { return this.ssh }
  createSsh(e: any) { this.ssh.push(e); return e }
  updateSsh() { return {} as any }
  deleteSsh() { return false }
  listWinrm() { return this.winrm }
  createWinrm(e: any) { this.winrm.push(e); return e }
  updateWinrm() { return {} as any }
  deleteWinrm() { return false }
}

function ctx(automation?: AutomationManager, cm?: FakeCM): ToolExecutionContext {
  return {
    sessionId: 's', messageId: 'm', terminalService: {} as any, sendEvent: () => {},
    commandPolicyService: {} as any, commandPolicyMode: 'standard',
    connectionManager: cm as any, automationManager: automation,
  } as any
}

function newManager() {
  let s: any = { automation: { groups: [], deviceMemory: [], scripts: [], scheduledTasks: [], templates: [] }, connections: { ssh: [], winrm: [], serial: [], proxies: [], tunnels: [] } }
  return new AutomationManager({ getSettings: () => s, setSettings: (p) => { s = { ...s, ...p, automation: p.automation ?? s.automation } } })
}

const cases: Array<{ name: string; run: () => Promise<void> }> = []
function test(n: string, r: () => Promise<void>) { cases.push({ name: n, run: r }) }

test('manage_device_memory full lifecycle', async () => {
  const am = newManager()
  await manageDeviceMemory({ action: 'upsert', host: '10.0.0.1', role: 'core-router', standingInstructions: 'never reload' }, ctx(am))
  await manageDeviceMemory({ action: 'add_incident', host: '10.0.0.1', incident: { summary: 'BGP flap', resolution: 'fixed ACL', ticketId: 'INC-1' } }, ctx(am))
  const get = await manageDeviceMemory({ action: 'get', host: '10.0.0.1' }, ctx(am))
  if (!get.includes('BGP flap') || !get.includes('INC-1') || !get.includes('never reload')) throw new Error(get)
  const list = await manageDeviceMemory({ action: 'list' }, ctx(am))
  if (!list.includes('10.0.0.1')) throw new Error(list)
  const del = await manageDeviceMemory({ action: 'delete', host: '10.0.0.1' }, ctx(am))
  if (!del.includes('Deleted')) throw new Error(del)
})

test('manage_device_memory without store returns unavailable', async () => {
  const res = await manageDeviceMemory({ action: 'list' }, ctx())
  if (!res.includes('not available')) throw new Error(res)
})

test('manage_script create/list/update/delete', async () => {
  const am = newManager()
  const c = await manageScript({ action: 'create', name: 'show-ver', command: 'show version' }, ctx(am))
  if (!c.includes('Created script')) throw new Error(c)
  const l = await manageScript({ action: 'list' }, ctx(am))
  if (!l.includes('show-ver')) throw new Error(l)
  const id = am.listScripts()[0].id
  const u = await manageScript({ action: 'update', id, command: 'show version | inc Version' }, ctx(am))
  if (!u.includes('Updated')) throw new Error(u)
  const d = await manageScript({ action: 'delete', id }, ctx(am))
  if (!d.includes('Deleted')) throw new Error(d)
})

test('manage_group create/list/delete', async () => {
  const am = newManager()
  await manageGroup({ action: 'create', name: 'DC-East' }, ctx(am))
  const l = await manageGroup({ action: 'list' }, ctx(am))
  if (!l.includes('DC-East')) throw new Error(l)
  const id = am.listGroups()[0].id
  const d = await manageGroup({ action: 'delete', id }, ctx(am))
  if (!d.includes('reparented')) throw new Error(d)
})

test('manage_scheduled_task create/list', async () => {
  const am = newManager()
  const c = await manageScheduledTask({ action: 'create', name: 'backup', cron: '0 2 * * *', command: 'show run' }, ctx(am))
  if (!c.includes('Created scheduled task')) throw new Error(c)
  const l = await manageScheduledTask({ action: 'list' }, ctx(am))
  if (!l.includes('backup') || !l.includes('0 2 * * *')) throw new Error(l)
})

test('manage_scheduled_task requires scriptId or command', async () => {
  const res = await manageScheduledTask({ action: 'create', name: 'x', cron: '* * * * *' }, ctx(newManager()))
  if (!res.includes('requires scriptId or command')) throw new Error(res)
})

test('manage_template create + render with default filters', async () => {
  const am = newManager()
  await manageTemplate({ action: 'create', name: 'iface', body: 'interface {{ name | default("G0/0") }}\n ip address {{ ip }}', variables: [{ name: 'name', defaultValue: 'G0/0' }, { name: 'ip' }] }, ctx(am))
  const id = am.listTemplates()[0].id
  const r = await manageTemplate({ action: 'render', id, values: { ip: '10.0.0.1' } }, ctx(am))
  if (!r.includes('interface G0/0') || !r.includes('ip address 10.0.0.1')) throw new Error(r)
})

test('manage_template version saves + returns diff vs previous', async () => {
  const am = newManager()
  await manageTemplate({ action: 'create', name: 'iface', body: 'interface {{ name }}', variables: [{ name: 'name' }] }, ctx(am))
  const id = am.listTemplates()[0].id
  const v1 = await manageTemplate({ action: 'version', id, values: { name: 'G0/0' } }, ctx(am))
  if (!v1.includes('first version')) throw new Error(v1)
  const v2 = await manageTemplate({ action: 'version', id, values: { name: 'G0/1' } }, ctx(am))
  if (!v2.includes('Diff vs previous')) throw new Error(v2)
  if (!v2.includes('+ interface G0/1')) throw new Error('expected diff with new version: ' + v2)
})

test('import_putty creates ssh connections, skips duplicates', async () => {
  const cm = new FakeCM()
  const reg = `[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\r1]
"HostName"="10.0.0.1"
"PortNumber"=dword:00000016
"Protocol"="ssh"
`
  const res = await importPutty({ regContent: reg }, ctx(undefined, cm))
  if (!res.includes('Imported 1')) throw new Error(res)
  if (cm.ssh.length !== 1 || cm.ssh[0].host !== '10.0.0.1') throw new Error('not created')
  // Second import of same session: skipped as duplicate by name
  const res2 = await importPutty({ regContent: reg }, ctx(undefined, cm))
  if (!res2.includes('skipped')) throw new Error(res2)
  if (cm.ssh.length !== 1) throw new Error('should not duplicate')
})

test('import_putty with no ssh sessions reports none', async () => {
  const res = await importPutty({ regContent: '' }, ctx(undefined, new FakeCM()))
  if (!res.includes('No SSH sessions')) throw new Error(res)
})

test('import_putty without connection manager returns unavailable', async () => {
  const res = await importPutty({ regContent: '' }, ctx())
  if (!res.includes('not available')) throw new Error(res)
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
