import { AutomationManager } from './AutomationManager'
import type { AutomationSettings } from '../../types'

function makeManager(initial?: Partial<AutomationSettings>) {
  let settings: any = {
    automation: {
      groups: [], deviceMemory: [], scripts: [], scheduledTasks: [], templates: [],
      ...initial,
    },
    connections: { ssh: [], winrm: [], serial: [], proxies: [], tunnels: [] },
  }
  const calls: any[] = []
  const m = new AutomationManager({
    getSettings: () => settings,
    setSettings: (patch) => {
      calls.push(patch)
      settings = {
        ...settings,
        ...patch,
        automation: patch.automation ?? settings.automation,
      }
    },
    onSettingsChanged: (s) => { calls.push(['changed', s]) },
    broadcastSettings: (s) => { calls.push(['broadcast', s]) },
  })
  return { m, getSettings: () => settings, calls }
}

const cases: Array<{ name: string; run: () => void }> = []
function test(n: string, r: () => void) { cases.push({ name: n, run: r }) }

test('groups: create/list/update/delete with reparent', () => {
  const { m } = makeManager()
  const g1 = m.createGroup('Data Center')
  const g2 = m.createGroup('East', g1.id)
  if (m.listGroups().length !== 2) throw new Error('count')
  m.updateGroup({ ...g2, name: 'DC-East' })
  if (m.listGroups().find((g) => g.id === g2.id)?.name !== 'DC-East') throw new Error('rename')
  m.deleteGroup(g1.id)
  // g2 was child of g1 -> reparented to root
  if (m.listGroups().find((g) => g.id === g2.id)?.parentId !== null) throw new Error('reparent')
})

test('device memory: upsert + addIncident + get', () => {
  const { m } = makeManager()
  m.upsertDeviceMemory({ host: '10.0.0.1', role: 'core-router', standingInstructions: 'never reload', incidents: [] })
  const inc = m.addIncident('10.0.0.1', { summary: 'BGP flap', resolution: 'fixed ACL', ticketId: 'INC-1' })
  if (!inc.at) throw new Error('incident should get timestamp')
  const mem = m.getDeviceMemory('10.0.0.1')
  if (mem?.incidents.length !== 1) throw new Error('incident count')
  if (mem?.incidents[0].ticketId !== 'INC-1') throw new Error('ticket')
  // upsert update path
  m.upsertDeviceMemory({ host: '10.0.0.1', role: 'core-router', incidents: [] })
  if (m.getDeviceMemory('10.0.0.1')?.incidents.length !== 1) throw new Error('upsert should preserve incidents')
  if (m.deleteDeviceMemory('10.0.0.1') !== true) throw new Error('delete true')
  if (m.deleteDeviceMemory('10.0.0.1') !== false) throw new Error('delete false on missing')
})

test('scripts: create/update/delete with timestamps', () => {
  const { m } = makeManager()
  const s = m.createScript({ name: 'show-version', command: 'show version' })
  if (!s.id || !s.createdAt) throw new Error('id/timestamps')
  const u = m.updateScript({ ...s, command: 'show version | include Version' })
  if (u.command !== 'show version | include Version') throw new Error('update')
  if (u.updatedAt === s.createdAt) throw new Error('updatedAt should change')
  if (m.deleteScript(s.id) !== true) throw new Error('delete')
  if (m.listScripts().length !== 0) throw new Error('empty after delete')
})

test('scheduled tasks: create/update/delete/markRun', () => {
  const { m } = makeManager()
  const t = m.createScheduledTask({ name: 'backup', cron: '0 2 * * *', scriptId: 's1', enabled: true })
  if (m.listScheduledTasks().length !== 1) throw new Error('count')
  m.updateScheduledTask({ ...t, enabled: false })
  if (m.listScheduledTasks()[0].enabled !== false) throw new Error('disable')
  m.markScheduledTaskRun(t.id)
  if (!m.listScheduledTasks()[0].lastRunAt) throw new Error('lastRunAt')
  m.deleteScheduledTask(t.id)
  if (m.listScheduledTasks().length !== 0) throw new Error('deleted')
})

test('templates: create/update/saveVersion/diff/delete', () => {
  const { m } = makeManager()
  const t = m.createTemplate({ name: 'iface', body: 'interface {{ name }}', variables: [{ name: 'name' }] })
  if (t.versions.length !== 0) throw new Error('starts with 0 versions')
  const v1 = m.saveTemplateVersion(t.id, 'interface G0/0', { name: 'G0/0' })
  const v2 = m.saveTemplateVersion(t.id, 'interface G0/1', { name: 'G0/1' })
  const stored = m.listTemplates().find((x) => x.id === t.id)!
  if (stored.versions.length !== 2) throw new Error('2 versions')
  if (stored.versions[1].rendered !== 'interface G0/1') throw new Error('latest version')
  m.updateTemplate({ id: t.id, body: 'interface {{ name | upper }}' })
  if (m.listTemplates()[0].body !== 'interface {{ name | upper }}') throw new Error('update body')
  m.deleteTemplate(t.id)
  if (m.listTemplates().length !== 0) throw new Error('deleted')
  void v1; void v2
})

test('throws on update of missing id (groups/scripts/tasks/templates)', () => {
  const { m } = makeManager()
  let threw = 0
  try { m.updateGroup({ id: 'x', name: 'y' }) } catch { threw++ }
  try { m.updateScript({ id: 'x' } as any) } catch { threw++ }
  try { m.updateScheduledTask({ id: 'x', name: 'x', cron: '* * * * *', enabled: true } as any) } catch { threw++ }
  try { m.updateTemplate({ id: 'x' }) } catch { threw++ }
  if (threw !== 4) throw new Error(`expected 4 throws, got ${threw}`)
})

test('broadcast is invoked on mutation', () => {
  const { m, calls } = makeManager()
  m.createGroup('x')
  if (!calls.some((c) => Array.isArray(c) && c[0] === 'broadcast')) throw new Error('expected broadcast call')
})

test('missing automation block defaults to empty safely', () => {
  let settings: any = {} // no automation key
  const m = new AutomationManager({ getSettings: () => settings, setSettings: (p) => { settings = { ...settings, ...p } } })
  if (m.listGroups().length !== 0) throw new Error('empty default')
  m.createGroup('g')
  if (m.listGroups().length !== 1) throw new Error('create after default')
})

test('playbooks: create/list/get/update/delete', () => {
  const { m } = makeManager()
  const pb = m.createPlaybook({
    name: 'Nightly config backup',
    steps: [
      { id: '', kind: 'command', command: 'term length 0', name: 'prep' },
      { id: '', kind: 'command', command: 'show run', name: 'collect' },
    ],
    groupId: 'grp-core',
  })
  if (!pb.id.startsWith('pb-')) throw new Error('id prefix')
  if (pb.steps.some((s) => !s.id)) throw new Error('step ids should be assigned')
  if (m.listPlaybooks().length !== 1) throw new Error('count')
  // get by id AND by name (case-insensitive)
  if (m.getPlaybook(pb.id)?.name !== 'Nightly config backup') throw new Error('get by id')
  if (m.getPlaybook('nightly config backup')?.id !== pb.id) throw new Error('get by name')
  // update
  m.updatePlaybook({ id: pb.id, description: 'backs up all core routers' })
  if (m.getPlaybook(pb.id)?.description !== 'backs up all core routers') throw new Error('update')
  if (!(m.getPlaybook(pb.id)!.updatedAt! >= pb.updatedAt!)) throw new Error('updatedAt bump')
  // delete
  if (m.deletePlaybook(pb.id) !== true) throw new Error('delete true')
  if (m.deletePlaybook(pb.id) !== false) throw new Error('delete false on missing')
  if (m.listPlaybooks().length !== 0) throw new Error('empty after delete')
})

test('playbooks: validation rejects bad steps and missing name', () => {
  const { m } = makeManager()
  let threw = 0
  try { m.createPlaybook({ name: '', steps: [{ id: '', kind: 'command', command: 'x' }] }) } catch { threw++ }
  try { m.createPlaybook({ name: 'x', steps: [] }) } catch { threw++ }
  try { m.createPlaybook({ name: 'x', steps: [{ id: '', kind: 'command' }] }) } catch { threw++ } // empty command
  try { m.createPlaybook({ name: 'x', steps: [{ id: '', kind: 'script' }] }) } catch { threw++ } // no scriptId
  try { m.createPlaybook({ name: 'x', steps: [{ id: '', kind: 'wait', waitSeconds: 0 }] }) } catch { threw++ } // bad wait
  try { m.createPlaybook({ name: 'x', steps: [{ id: '', kind: 'nope' as any, command: 'x' }] }) } catch { threw++ } // bad kind
  if (threw !== 6) throw new Error(`expected 6 throws, got ${threw}`)
})

test('playbooks: validate/rollback field validation (MOP fields)', () => {
  const { m } = makeManager()
  let threw = 0
  const base = { id: '', kind: 'command' as const, command: 'x' }
  // validate: needs exactly one of command|scriptId
  try { m.createPlaybook({ name: 'x', steps: [{ ...base, validate: { expect: 'y' } }] }) } catch { threw++ }
  try { m.createPlaybook({ name: 'x', steps: [{ ...base, validate: { command: 'c', scriptId: 's', expect: 'y' } }] }) } catch { threw++ }
  // validate: empty expect
  try { m.createPlaybook({ name: 'x', steps: [{ ...base, validate: { command: 'c', expect: '' } }] }) } catch { threw++ }
  // validate: bad expectMode
  try { m.createPlaybook({ name: 'x', steps: [{ ...base, validate: { command: 'c', expect: 'y', expectMode: 'fuzzy' as any } }] }) } catch { threw++ }
  // validate on wait step
  try { m.createPlaybook({ name: 'x', steps: [{ id: '', kind: 'wait', waitSeconds: 1, validate: { command: 'c', expect: 'y' } }] }) } catch { threw++ }
  // rollback: bad kind
  try { m.createPlaybook({ name: 'x', steps: [{ ...base, rollback: { kind: 'nope' as any, command: 'c' } }] }) } catch { threw++ }
  // rollback: command kind without command
  try { m.createPlaybook({ name: 'x', steps: [{ ...base, rollback: { kind: 'command' } }] }) } catch { threw++ }
  // rollback: script kind without scriptId
  try { m.createPlaybook({ name: 'x', steps: [{ ...base, rollback: { kind: 'script' } }] }) } catch { threw++ }
  // rollback on wait step
  try { m.createPlaybook({ name: 'x', steps: [{ id: '', kind: 'wait', waitSeconds: 1, rollback: { kind: 'command', command: 'c' } }] }) } catch { threw++ }
  if (threw !== 9) throw new Error(`expected 9 throws, got ${threw}`)
  // valid MOP step passes and round-trips with requireApproval
  const pb = m.createPlaybook({
    name: 'mop',
    requireApproval: true,
    steps: [{
      id: '', kind: 'command', command: 'apply',
      validate: { command: 'check', expect: 'ok', expectMode: 'regex' },
      rollback: { kind: 'script', scriptId: 'scr-undo' },
    }],
  })
  const got = m.getPlaybook(pb.id)!
  if (got.requireApproval !== true) throw new Error('requireApproval should persist')
  if (got.steps[0].validate?.expect !== 'ok') throw new Error('validate should persist')
  if (got.steps[0].rollback?.scriptId !== 'scr-undo') throw new Error('rollback should persist')
})

test('playbooks: markPlaybookRun stamps last-run status', () => {
  const { m } = makeManager()
  const pb = m.createPlaybook({ name: 'pb', steps: [{ id: '', kind: 'command', command: 'x' }] })
  m.markPlaybookRun(pb.id, true)
  const after = m.getPlaybook(pb.id)!
  if (!after.lastRunAt) throw new Error('lastRunAt should be set')
  if (after.lastRunOk !== true) throw new Error('lastRunOk should be true')
  m.markPlaybookRun(pb.id, false)
  if (m.getPlaybook(pb.id)!.lastRunOk !== false) throw new Error('lastRunOk should flip to false')
  // unknown id is a no-op (never throws)
  m.markPlaybookRun('pb-ghost', true)
})

test('playbooks: pre-existing settings without playbooks key default safely', () => {
  // Simulates settings written before the playbooks feature existed.
  const { m } = makeManager({ scripts: [{ id: 's1', name: 's', command: 'c' }] })
  if (m.listPlaybooks().length !== 0) throw new Error('should default to empty')
  m.createPlaybook({ name: 'p', steps: [{ id: '', kind: 'command', command: 'x' }] })
  if (m.listPlaybooks().length !== 1) throw new Error('create after default')
  // other slices untouched
  if (m.listScripts().length !== 1) throw new Error('scripts preserved')
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
