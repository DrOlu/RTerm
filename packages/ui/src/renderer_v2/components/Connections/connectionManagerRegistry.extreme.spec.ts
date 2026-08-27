import {
  CONNECTION_MANAGER_SECTIONS,
  getConnectionManagerSectionDefinition,
} from './connectionManagerRegistry'
import { connectionNavLabel } from './connectionNavLabel'

const assertCondition = (condition: unknown, message: string): void => {
  if (!condition) {
    throw new Error(message)
  }
}

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(
      `${message}. expected=${String(expected)} actual=${String(actual)}`,
    )
  }
}

const runCase = (name: string, fn: () => void | Promise<void>): Promise<void> =>
  Promise.resolve(fn()).then(() => console.log(`PASS ${name}`))

await runCase('connection manager includes templates AND triggers as distinct sections', () => {
  const ids = CONNECTION_MANAGER_SECTIONS.map((item) => item.id)
  assertCondition(ids.includes('templates'), 'templates registered')
  assertCondition(ids.includes('triggers'), 'triggers registered')
  assertCondition(ids.includes('playbooks'), 'playbooks registered')
  assertCondition(ids.includes('scheduledTasks'), 'scheduledTasks registered')
  assertEqual(
    ids.filter((id) => id === 'templates').length,
    1,
    'templates appears once',
  )
  assertEqual(
    ids.filter((id) => id === 'triggers').length,
    1,
    'triggers appears once',
  )
})

await runCase('nav labels: triggers is never Templates', () => {
  const t = {
    connections: {
      templates: 'Templates',
      playbooks: 'Playbooks',
      triggers: 'Triggers',
      ssh: 'SSH',
      winrm: 'WinRM',
      serial: 'Serial',
      proxy: 'Proxy',
      tunnels: 'Tunnels',
      groups: 'Groups',
      scripts: 'Scripts',
      scheduledTasks: 'Scheduled Tasks',
    },
  }
  const labels = CONNECTION_MANAGER_SECTIONS.map((s) => connectionNavLabel(s, t))
  assertEqual(labels.filter((l) => l === 'Templates').length, 1, 'one Templates')
  assertCondition(labels.includes('Triggers'), 'Triggers labeled')
})

await runCase('ssh section creates a valid default draft', () => {
  const draft = getConnectionManagerSectionDefinition('ssh').createDraft()
  assertCondition(String(draft.id || '').startsWith('ssh-'), 'ssh drafts should use ssh id prefix')
  assertEqual(draft.port, 22, 'ssh drafts should default to port 22')
  assertEqual(draft.authMethod, 'password', 'ssh drafts should default to password auth')
})

await runCase('proxy section creates a valid default draft', () => {
  const draft = getConnectionManagerSectionDefinition('proxies').createDraft()
  assertCondition(String(draft.id || '').startsWith('proxy-'), 'proxy drafts should use proxy id prefix')
  assertEqual(draft.port, 1080, 'proxy drafts should default to port 1080')
  assertEqual(draft.type, 'socks5', 'proxy drafts should default to socks5')
})

await runCase('tunnel section creates a valid default draft', () => {
  const draft = getConnectionManagerSectionDefinition('tunnels').createDraft()
  assertCondition(String(draft.id || '').startsWith('tunnel-'), 'tunnel drafts should use tunnel id prefix')
  assertEqual(draft.port, 8080, 'tunnel drafts should default to port 8080')
  assertEqual(draft.type, 'Local', 'tunnel drafts should default to local forwarding')
})

await runCase('trigger draft defaults are valid', () => {
  const draft = getConnectionManagerSectionDefinition('triggers').createDraft()
  assertCondition(String(draft.id || '').startsWith('trg-'), 'trg prefix')
  assertEqual(draft.kind, 'pattern', 'default kind')
  assertEqual(draft.action, 'run-playbook', 'default action')
  assertEqual(draft.enabled, true, 'enabled')
  assertEqual(draft.cooldownSeconds, 300, 'cooldown')
})

await runCase('trigger save/delete go through store methods (not a raw settings.set that can wipe siblings)', async () => {
  const saved: any[] = []
  const deleted: string[] = []
  const store = {
    saveTrigger: async (d: any) => { saved.push(d) },
    deleteTrigger: async (id: string) => { deleted.push(id) },
  } as any
  const def = getConnectionManagerSectionDefinition('triggers')
  const draft = def.createDraft()
  draft.name = 'bgp-down'
  await def.saveDraft(store, draft)
  assertEqual(saved.length, 1, 'saved once')
  assertEqual(saved[0].name, 'bgp-down', 'name kept')
  await def.deleteEntry(store, draft.id)
  assertEqual(deleted[0], draft.id, 'deleted by id')
})

await runCase('section registry routes to matching settings entries', () => {
  const store = {
    settings: {
      connections: {
        ssh: [{ id: 'ssh-a' }],
        proxies: [{ id: 'proxy-a' }],
        tunnels: [{ id: 'tunnel-a' }],
        winrm: [{ id: 'winrm-a' }],
        serial: [{ id: 'serial-a' }],
      },
      automation: {
        groups: [{ id: 'g1' }],
        scripts: [{ id: 's1' }],
        scheduledTasks: [{ id: 't1' }],
        templates: [{ id: 'tpl1' }],
        playbooks: [{ id: 'pb1' }],
        triggers: [{ id: 'trg1' }],
      },
    },
  } as any

  assertEqual(
    getConnectionManagerSectionDefinition('ssh').getEntries(store)[0]?.id,
    'ssh-a',
    'ssh section should resolve ssh entries from settings',
  )
  assertEqual(
    getConnectionManagerSectionDefinition('proxies').getEntries(store)[0]?.id,
    'proxy-a',
    'proxy section should resolve proxy entries from settings',
  )
  assertEqual(
    getConnectionManagerSectionDefinition('tunnels').getEntries(store)[0]?.id,
    'tunnel-a',
    'tunnel section should resolve tunnel entries from settings',
  )
  assertEqual(
    getConnectionManagerSectionDefinition('triggers').getEntries(store)[0]?.id,
    'trg1',
    'triggers section should resolve triggers from automation',
  )
  assertEqual(
    getConnectionManagerSectionDefinition('templates').getEntries(store)[0]?.id,
    'tpl1',
    'templates section should resolve templates from automation',
  )
})

console.log('All connection manager registry extreme tests passed.')
