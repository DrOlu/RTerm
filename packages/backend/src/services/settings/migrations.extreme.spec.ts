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
      playbooks: [
        {
          id: 'pb-1',
          name: 'nightly-backup',
          steps: [
            { id: 'st-1', kind: 'command', command: 'term length 0', name: 'prep' },
            { id: 'st-2', kind: 'script', scriptId: 'scr-1', name: 'collect' },
            { id: 'st-3', kind: 'wait', waitSeconds: 5 },
          ],
          groupId: 'grp-1',
          onError: 'stop',
          requireApproval: true,
        },
        {
          id: 'pb-2',
          name: 'core-mop',
          steps: [
            {
              id: 'st-9', kind: 'command', command: 'apply acl', name: 'change',
              validate: { command: 'show bgp', expect: 'Established', expectMode: 'substring' },
              rollback: { kind: 'script', scriptId: 'scr-1' },
            },
          ],
          targets: ['core-rtr-01'],
        },
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
  assertEqual(migrated.automation!.playbooks.length, 2, 'playbooks should survive migration')
  assertEqual(migrated.automation!.playbooks[0].name, 'nightly-backup', 'playbook name should survive')
  assertEqual(migrated.automation!.playbooks[0].steps.length, 3, 'playbook steps should survive')
  assertEqual(migrated.automation!.playbooks[0].steps[1].scriptId, 'scr-1', 'playbook step script ref should survive')
  assertEqual(migrated.automation!.playbooks[0].requireApproval, true, 'requireApproval should survive')
  const mop = migrated.automation!.playbooks[1]
  assertEqual(mop.steps[0].validate?.expect, 'Established', 'step validation should survive migration')
  assertEqual(mop.steps[0].rollback?.scriptId, 'scr-1', 'step rollback should survive migration')
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
  assertEqual(migrated.schemaVersion, 5, 'should bump to schema v5')
  assertEqual(migrated.automation!.groups.length, 1, 'legacy group should survive v3→v5 migration')
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

test('migrateBackendSettings defaults a missing cost block (v4→v5)', () => {
  const stored = { ...DEFAULT_BACKEND_SETTINGS, schemaVersion: 4 }
  delete (stored as any).cost
  const migrated = migrateBackendSettings(stored)
  assertEqual(migrated.schemaVersion, 5, 'should bump to schema v5')
  assertEqual(migrated.cost!.modelPrices, {}, 'missing cost.modelPrices should default to empty')
  assertEqual(migrated.cost!.budgets, [], 'missing cost.budgets should default to empty')
})

test('migrateBackendSettings preserves the cost block across save+reload', () => {
  const stored = {
    ...DEFAULT_BACKEND_SETTINGS,
    schemaVersion: 4,
    cost: {
      modelPrices: {
        'moonshotai/kimi-k3': { promptPer1M: 0.6, completionPer1M: 2.5 },
        default: { promptPer1M: 1, completionPer1M: 2 },
      },
      budgets: [
        { id: 'daily-all', model: '*', period: 'daily', capUsd: 25, warnAt: 0.8, overAction: 'throttle' },
        { id: 'monthly-kimi', model: 'moonshotai/kimi-k3', period: 'monthly', capUsd: 500, overAction: 'deny' },
      ],
    },
  }
  const afterSave = migrateBackendSettings(stored)
  const afterReload = migrateBackendSettings(afterSave)
  assertEqual(afterReload.cost!.modelPrices['moonshotai/kimi-k3'].promptPer1M, 0.6, 'price prompt rate should survive')
  assertEqual(afterReload.cost!.modelPrices['moonshotai/kimi-k3'].completionPer1M, 2.5, 'price completion rate should survive')
  assertEqual(afterReload.cost!.modelPrices['default'].promptPer1M, 1, 'default price should survive')
  assertEqual(afterReload.cost!.budgets.length, 2, 'budgets should survive')
  assertEqual(afterReload.cost!.budgets[0].capUsd, 25, 'budget cap should survive')
  assertEqual(afterReload.cost!.budgets[1].overAction, 'deny', 'budget overAction should survive')
})

test('normalizeCostSettings sanitizes malformed prices and budgets', () => {
  const migrated = migrateBackendSettings({
    ...DEFAULT_BACKEND_SETTINGS,
    schemaVersion: 4,
    cost: {
      modelPrices: {
        good: { promptPer1M: 5, completionPer1M: 15 },
        negative: { promptPer1M: -3, completionPer1M: 2 },
        notnumbers: { promptPer1M: 'abc', completionPer1M: null },
      },
      budgets: [
        { id: 'ok', period: 'daily', capUsd: 10 },
        { id: '', period: 'daily', capUsd: 10 },          // dropped: empty id
        { id: 'nocap', period: 'daily', capUsd: 0 },      // dropped: cap <= 0
        { id: 'badcap', period: 'daily', capUsd: 'xyz' }, // dropped: non-numeric cap
        'not-an-object',                                   // dropped: not an object
      ],
    },
  } as any)
  assertEqual(migrated.cost!.modelPrices.good.promptPer1M, 5, 'good price preserved')
  assertEqual(migrated.cost!.modelPrices.negative.promptPer1M, 0, 'negative price clamped to 0')
  assertEqual(migrated.cost!.modelPrices.notnumbers.promptPer1M, 0, 'non-numeric price coerced to 0')
  assertEqual(migrated.cost!.budgets.length, 1, 'only the valid budget survives')
  assertEqual(migrated.cost!.budgets[0].id, 'ok', 'valid budget id preserved')
})

test('normalizeAlertsSettings defaults a missing alerts block', () => {
  const stored = { ...DEFAULT_BACKEND_SETTINGS, schemaVersion: 4 }
  delete (stored as any).alerts
  const migrated = migrateBackendSettings(stored)
  assertEqual(migrated.alerts!.channels, [], 'missing alerts should default to empty channels')
})

test('normalizeAlertsSettings preserves valid channels + coerces fields', () => {
  const migrated = migrateBackendSettings({
    ...DEFAULT_BACKEND_SETTINGS,
    schemaVersion: 4,
    alerts: {
      channels: [
        { id: 'slack-oncall', name: 'Slack Oncall', type: 'slack', enabled: true, minSeverity: 'critical', secretRef: 'slack-webhook' },
        { id: 'tg', name: '', type: 'telegram', enabled: true, secretRef: 'tg-token', chatId: '12345' },
        { id: 'smtp-alerts', name: 'Email', type: 'smtp', enabled: false, smtp: { host: 'smtp.example.com', port: 587, user: 'u', from: 'rterm@example.com', to: ['ops@example.com'] }, secretRef: 'smtp-pass' },
      ],
    },
  } as any)
  assertEqual(migrated.alerts!.channels.length, 3, 'all valid channels survive')
  const slack = migrated.alerts!.channels[0]
  assertEqual(slack.minSeverity, 'critical', 'minSeverity preserved')
  assertEqual(slack.secretRef, 'slack-webhook', 'secretRef preserved (no inline secret)')
  const tg = migrated.alerts!.channels[1]
  assertEqual(tg.name, 'tg', 'empty name falls back to id')
  assertEqual(tg.chatId, '12345', 'telegram chatId preserved')
  const smtp = migrated.alerts!.channels[2]
  assertEqual(smtp.enabled, false, 'enabled=false preserved')
  assertEqual(smtp.smtp!.port, 587, 'smtp port preserved')
  assertEqual(smtp.smtp!.to.length, 1, 'smtp recipients preserved')
})

test('normalizeAlertsSettings drops malformed channels + bad smtp', () => {
  const migrated = migrateBackendSettings({
    ...DEFAULT_BACKEND_SETTINGS,
    schemaVersion: 4,
    alerts: {
      channels: [
        { id: '', name: 'no-id', type: 'slack', enabled: true },                       // dropped: empty id
        'not-an-object',                                                               // dropped
        { id: 'bad-smtp', name: 'x', type: 'smtp', enabled: true, smtp: { host: '', from: '', to: [] } }, // kept but smtp stripped (invalid)
      ],
    },
  } as any)
  assertEqual(migrated.alerts!.channels.length, 1, 'only the well-formed-id channel survives')
  assertEqual(migrated.alerts!.channels[0].smtp, undefined, 'invalid smtp config stripped')
})

test('normalizeOncallSettings defaults a missing oncall block', () => {
  const stored = { ...DEFAULT_BACKEND_SETTINGS, schemaVersion: 4 }
  delete (stored as any).oncall
  const migrated = migrateBackendSettings(stored)
  assertEqual(migrated.oncall!.pagingChannels, [], 'missing oncall should default to empty pagingChannels')
})

test('normalizeOncallSettings preserves valid paging channels incl. webhook + smtp', () => {
  const migrated = migrateBackendSettings({
    ...DEFAULT_BACKEND_SETTINGS,
    schemaVersion: 4,
    oncall: {
      pagingChannels: [
        { id: 'hook', name: 'pager', type: 'webhook', enabled: true, webhookUrl: 'https://hooks.example.com/page', minSeverity: 'warning' },
        { id: 'tg-oncall', name: '', type: 'telegram', enabled: true, secretRef: 'tg-token', chatId: '999' },
        { id: 'email-oncall', name: 'Email', type: 'smtp', enabled: true, smtp: { host: 'smtp.example.com', port: 465, secure: true, user: 'u', from: 'rterm@x.com', to: ['oncall@x.com'] }, secretRef: 'smtp-pass' },
      ],
    },
  } as any)
  assertEqual(migrated.oncall!.pagingChannels.length, 3, 'all valid paging channels survive')
  const hook = migrated.oncall!.pagingChannels[0]
  assertEqual(hook.type, 'webhook', 'webhook type preserved')
  assertEqual(hook.webhookUrl, 'https://hooks.example.com/page', 'inline webhookUrl preserved')
  assertEqual(hook.minSeverity, 'warning', 'minSeverity preserved')
  const tg = migrated.oncall!.pagingChannels[1]
  assertEqual(tg.name, 'tg-oncall', 'empty name falls back to id')
  const email = migrated.oncall!.pagingChannels[2]
  assertEqual(email.smtp!.secure, true, 'smtp secure preserved')
  assertEqual(email.smtp!.port, 465, 'smtp port preserved')
})

test('normalizeOncallSettings drops malformed + unknown-type defaults to webhook', () => {
  const migrated = migrateBackendSettings({
    ...DEFAULT_BACKEND_SETTINGS,
    schemaVersion: 4,
    oncall: {
      pagingChannels: [
        { id: '', name: 'no-id', type: 'slack', enabled: true },       // dropped: empty id
        'not-an-object',                                               // dropped
        { id: 'mystery', name: 'M', type: 'carrier-pigeon', enabled: true, webhookUrl: 'https://x' }, // unknown type → webhook
      ],
    },
  } as any)
  assertEqual(migrated.oncall!.pagingChannels.length, 1, 'only well-formed-id channel survives')
  assertEqual(migrated.oncall!.pagingChannels[0].type, 'webhook', 'unknown type coerced to webhook')
})

test('normalizeCloudSettings defaults a missing cloud block', () => {
  const stored = { ...DEFAULT_BACKEND_SETTINGS, schemaVersion: 4 }
  delete (stored as any).cloud
  const migrated = migrateBackendSettings(stored)
  assertEqual(migrated.cloud!.accounts, [], 'missing cloud should default to empty accounts')
})

test('normalizeCloudSettings preserves valid accounts + coerces fields', () => {
  const migrated = migrateBackendSettings({
    ...DEFAULT_BACKEND_SETTINGS,
    schemaVersion: 4,
    cloud: {
      accounts: [
        { id: 'prod-aws', provider: 'aws', name: 'Prod AWS', accountId: '123456789012', region: 'us-east-1', secretRef: 'aws-creds', enabled: true },
        { id: 'gcp-main', provider: 'gcp', name: '', accountId: 'my-project', enabled: false },
        { id: 'az-sub', provider: 'azure', name: 'Azure', accountId: 'sub-abc', region: 'eastus' },
      ],
    },
  } as any)
  assertEqual(migrated.cloud!.accounts.length, 3, 'all valid accounts survive')
  const aws = migrated.cloud!.accounts[0]
  assertEqual(aws.region, 'us-east-1', 'region preserved')
  assertEqual(aws.secretRef, 'aws-creds', 'secretRef preserved (no inline creds)')
  const gcp = migrated.cloud!.accounts[1]
  assertEqual(gcp.name, 'my-project', 'empty name falls back to accountId')
  assertEqual(gcp.enabled, false, 'enabled=false preserved')
  const az = migrated.cloud!.accounts[2]
  assertEqual(az.enabled, true, 'enabled defaults to true')
})

test('normalizeCloudSettings drops malformed + coerces unknown provider', () => {
  const migrated = migrateBackendSettings({
    ...DEFAULT_BACKEND_SETTINGS,
    schemaVersion: 4,
    cloud: {
      accounts: [
        { id: '', provider: 'aws', accountId: 'x' },                 // dropped: empty id
        { id: 'noacct', provider: 'aws', accountId: '' },            // dropped: empty accountId
        'not-an-object',                                             // dropped
        { id: 'odd', provider: 'digitalocean', accountId: 'droplet-1' }, // unknown provider → aws
      ],
    },
  } as any)
  assertEqual(migrated.cloud!.accounts.length, 1, 'only well-formed account survives')
  assertEqual(migrated.cloud!.accounts[0].provider, 'aws', 'unknown provider coerced to aws')
})

test('normalizeAgentspanSettings defaults + preserves + sanitizes', () => {
  // missing block → default enabled, no serverUrl
  const d = migrateBackendSettings({ ...DEFAULT_BACKEND_SETTINGS, schemaVersion: 4 } as any)
  delete (d as any).agentspan
  const def = migrateBackendSettings(d)
  assertEqual(def.agentspan!.enabled, true, 'agentspan defaults to enabled')
  assertEqual(def.agentspan!.serverUrl, undefined, 'no serverUrl by default (plugin falls back to localhost:6767)')
  // valid block preserved
  const m = migrateBackendSettings({
    ...DEFAULT_BACKEND_SETTINGS,
    schemaVersion: 4,
    agentspan: { serverUrl: ' http://conductor:6767/ ', authSecretRef: 'as-auth', enabled: false },
  } as any)
  assertEqual(m.agentspan!.serverUrl, 'http://conductor:6767/', 'serverUrl trimmed of whitespace (trailing slash stripped by plugin)')
  assertEqual(m.agentspan!.authSecretRef, 'as-auth', 'authSecretRef preserved (no inline secret)')
  assertEqual(m.agentspan!.enabled, false, 'enabled=false preserved')
  // garbage → safe defaults
  const g = migrateBackendSettings({ ...DEFAULT_BACKEND_SETTINGS, schemaVersion: 4, agentspan: 'junk' } as any)
  assertEqual(g.agentspan!.enabled, true, 'garbage block → enabled default')
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
