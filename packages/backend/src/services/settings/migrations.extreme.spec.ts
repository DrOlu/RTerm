import {
  migrateBackendSettings,
  DEFAULT_BACKEND_SETTINGS,
} from './migrations'

const cases: Array<{ name: string; run: () => void }> = []
function test(n: string, r: () => void) { cases.push({ name: n, run: r }) }

const assertEqual = (actual: unknown, expected: unknown, message: string): void => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}. expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`,
    )
  }
}

test('migrateBackendSettings preserves a persisted automation block (groups survive restart)', () => {
  // Regression: pickBackendSnapshot used to omit `automation`, so every
  // migration pass (run on both getSettings and setSettings) wiped groups,
  // scripts, scheduled tasks, templates and device memory — they reloaded as
  // empty after a restart.
  const stored = {
    ...DEFAULT_BACKEND_SETTINGS,
    schemaVersion: 4,
    automation: {
      groups: [{ id: 'grp-1', name: 'Core', parentId: null }],
      deviceMemory: [
        {
          host: 'core-rtr-01',
          standingInstructions: 'Check BGP before changes',
          incidents: [],
        },
      ],
      scripts: [
        { id: 'scr-1', name: 'backup', command: 'show run', description: '', tags: [] },
      ],
      scheduledTasks: [
        { id: 'sch-1', name: 'nightly', cron: '0 2 * * *', command: 'show run', enabled: true },
      ],
      templates: [
        { id: 'tpl-1', name: 'base', body: 'hostname {{hostname}}', variables: [], versions: [] },
      ],
    },
  }

  const migrated = migrateBackendSettings(stored)
  assertEqual(migrated.automation!.groups.length, 1, 'groups should survive migration')
  assertEqual(migrated.automation!.groups[0].name, 'Core', 'group name should survive')
  assertEqual(migrated.automation!.scripts.length, 1, 'scripts should survive migration')
  assertEqual(migrated.automation!.scheduledTasks.length, 1, 'scheduled tasks should survive migration')
  assertEqual(migrated.automation!.templates.length, 1, 'templates should survive migration')
  assertEqual(migrated.automation!.deviceMemory.length, 1, 'device memory should survive migration')
  assertEqual(
    migrated.automation!.scheduledTasks[0].cron,
    '0 2 * * *',
    'scheduled task cron should survive',
  )
})

test('migrateBackendSettings preserves the sessionLogging flag across migration', () => {
  // Same root cause: sessionLogging was also dropped by pickBackendSnapshot, so
  // enabling session logging never persisted.
  const stored = {
    ...DEFAULT_BACKEND_SETTINGS,
    schemaVersion: 4,
    sessionLogging: { enabled: true },
  }
  const migrated = migrateBackendSettings(stored)
  assertEqual(migrated.sessionLogging!.enabled, true, 'session logging should stay enabled')
})

test('migrateBackendSettings fills empty automation with defaults when absent', () => {
  const stored = { ...DEFAULT_BACKEND_SETTINGS, schemaVersion: 4 }
  delete (stored as any).automation
  const migrated = migrateBackendSettings(stored)
  assertEqual(migrated.automation!.groups.length, 0, 'missing automation should default to empty')
  assertEqual(migrated.automation!.scheduledTasks.length, 0, 'missing scheduled tasks should default to empty')
})

test('migrateBackendSettings preserves automation when migrating from an older schema version', () => {
  // A v3 store (pre-agentSettings) carrying automation must keep it through the v4 migration.
  const stored = {
    schemaVersion: 3,
    commandPolicyMode: 'standard',
    model: '',
    baseUrl: '',
    apiKey: '',
    connections: { ssh: [], winrm: [], serial: [], proxies: [], tunnels: [] },
    tools: { builtIn: {}, skills: {} },
    gateway: { ws: { access: 'localhost', port: 17888, allowedCidrs: [] }, mobileWeb: { port: null } },
    layout: { panelSizes: [50, 50], panelOrder: ['chat', 'terminal'], savedLayouts: [], activeSavedLayoutId: null },
    recursionLimit: 200,
    memory: { enabled: true },
    automation: {
      groups: [{ id: 'grp-legacy', name: 'Legacy', parentId: null }],
      deviceMemory: [],
      scripts: [],
      scheduledTasks: [],
      templates: [],
    },
  }
  const migrated = migrateBackendSettings(stored)
  assertEqual(migrated.schemaVersion, 4, 'should bump to schema v4')
  assertEqual(migrated.automation!.groups.length, 1, 'legacy group should survive v3→v4 migration')
  assertEqual(migrated.automation!.groups[0].name, 'Legacy', 'legacy group name should survive')
})

test('migrateBackendSettings round-trips a save then load without losing groups', () => {
  // Simulate the setSettings→getSettings round trip the UI/agent use.
  const stored = { ...DEFAULT_BACKEND_SETTINGS, schemaVersion: 4 }
  // First save (setSettings): deepMerge the patch, then migrate.
  const patch = {
    automation: {
      groups: [{ id: 'grp-1', name: 'Core', parentId: null }],
      deviceMemory: [],
      scripts: [],
      scheduledTasks: [],
      templates: [],
    },
  }
  const merged = { ...stored, ...patch } as any
  const afterSave = migrateBackendSettings(merged)
  // Simulate a restart: reload from the persisted (migrated) store.
  const afterReload = migrateBackendSettings(afterSave)
  assertEqual(afterReload.automation!.groups.length, 1, 'group must survive a save+reload round trip')
  assertEqual(afterReload.automation!.groups[0].name, 'Core', 'group name must survive a round trip')
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
