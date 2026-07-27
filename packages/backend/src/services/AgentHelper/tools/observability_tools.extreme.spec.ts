import {
  getMetrics, manageSecret, manageOncall, getCost, manageRecording,
  manageGitops, managePlaybookVersion, getCloudInventory, getLiveDashboard,
  getMonitorStatus,
} from './observability_tools'
import { SecretsVault } from '../../secrets/secretsVault'
import { EscalationService } from '../../oncall/escalationService'
import { CostBudgetService } from '../../cost/costBudgetService'
import { SessionRecorder } from '../../recording/sessionRecorder'
import { GitOpsService } from '../../gitops/gitOpsService'
import { PlaybookVersioning, lintPlaybook, lintOk } from '../../automation/playbookVersioning'
import { CloudInventory } from '../../cloud/cloudInventory'
import { LiveDashboardHub } from '../../liveui/liveDashboardHub'
import { registryFromHostMetrics } from '../../sre/prometheusExporter'
import type { Observability } from '../../observability'
import type { ToolExecutionContext } from '../types'

const cases: Array<{ name: string; run: () => void | Promise<void> }> = []
function test(n: string, r: () => void | Promise<void>) { cases.push({ name: n, run: r }) }
function ok(v: unknown, m = '') { if (!v) throw new Error(m || 'expected truthy') }
function includes(h: string, n: string, m = '') { if (!h.includes(n)) throw new Error(`${m} expected ${JSON.stringify(n)} in:\n${h}`) }

function makeObs(): Observability {
  return {
    metricsExport: { registry: null, otel: null, registryFromHostMetrics, renderPrometheus: () => 'rterm_up 1\n' },
    secrets: new SecretsVault({ masterKey: 'pw' }),
    oncall: new EscalationService(),
    cost: new CostBudgetService({ prices: { 'gpt-4o': { promptPer1M: 5, completionPer1M: 15 } } }),
    recording: new SessionRecorder(),
    gitops: new GitOpsService({ readLive: () => [] }),
    playbooks: { versioning: new PlaybookVersioning(), lint: lintPlaybook, lintOk },
    cloud: new CloudInventory(),
    liveDashboard: new LiveDashboardHub({ getState: () => ({}) }),
    dashboard: { summary: async () => '2 hosts, 0 down', state: async () => ({}) },
    monitorStatus: {
      report: () => ({ publisherWired: true, terminalCount: 1, entries: [{ terminalId: 'local-1', connected: true, platform: 'darwin', hasSession: false, inFlight: false, lastCollectAt: 0, lastCollectAgoMs: -1, diagnosis: 'no_monitor_session' }], issues: ['local-1: no_monitor_session'] }),
      summary: () => 'publisher=wired\nterminals=1\nissues=1:\n  - local-1: no_monitor_session',
    },
  } as unknown as Observability
}

function ctx(obsHandle?: Observability): { c: ToolExecutionContext; events: string[] } {
  const events: string[] = []
  const c = {
    sessionId: 's1', messageId: 'm1',
    terminalService: {} as never,
    sendEvent: (_s: string, e: { output?: string }) => { events.push(String(e.output ?? '')) },
    commandPolicyService: {} as never,
    commandPolicyMode: 'standard' as never,
    observability: obsHandle,
  } as unknown as ToolExecutionContext
  return { c, events }
}

// ─── availability guard ───
test('every tool reports a clear message when observability is not wired', async () => {
  const { c } = ctx(undefined)
  for (const [fn, args] of [
    [getMetrics, {}], [manageSecret, { action: 'list' }], [manageOncall, { action: 'open_pages' }],
    [getCost, { action: 'summary' }], [manageRecording, { action: 'list' }], [manageGitops, { action: 'export' }],
    [managePlaybookVersion, { action: 'history', playbookId: 'x' }], [getCloudInventory, { action: 'summary' }],
    [getMonitorStatus, {}],
    [getLiveDashboard, { action: 'state' }],
  ] as Array<[(a: any, c: ToolExecutionContext) => Promise<string>, any]>) {
    const out = await fn(args, c)
    includes(out, 'not available', `${fn.name} should report unavailable`)
  }
})

// ─── metrics ───
test('get_metrics prometheus + summary', async () => {
  const { c } = ctx(makeObs())
  includes(await getMetrics({ format: 'prometheus' }, c), 'rterm_up 1')
  includes(await getMetrics({ format: 'summary' }, c), '2 hosts')
})

// ─── secrets ───
test('manage_secret set/list/has/delete; value never echoed', async () => {
  const { c, events } = ctx(makeObs())
  includes(await manageSecret({ action: 'set', key: 'k1', value: 'topsecret' }, c), 'Stored')
  includes(await manageSecret({ action: 'has', key: 'k1' }, c), 'exists')
  includes(await manageSecret({ action: 'list' }, c), 'k1')
  ok(!events.join('').includes('topsecret'), 'secret value never emitted')
  includes(await manageSecret({ action: 'delete', key: 'k1' }, c), 'Deleted')
})
test('manage_secret reports locked vault', async () => {
  const o = makeObs(); (o as any).secrets = new SecretsVault() // no master key → locked
  const { c } = ctx(o)
  includes(await manageSecret({ action: 'list' }, c), 'locked')
})

// ─── on-call ───
test('manage_oncall page → open_pages → ack → resolve', async () => {
  const o = makeObs()
  o.oncall.registerPolicy({ id: 'p1', name: 'x', levels: [{ targets: [{ id: '@a', channel: 'c' }], ackTimeoutMs: 100 }] })
  const { c } = ctx(o)
  includes(await manageOncall({ action: 'list_policies' }, c), 'p1')
  includes(await manageOncall({ action: 'page', incidentId: 'i', policyId: 'p1', title: 'T', severity: 'sev1' }, c), 'Paged')
  includes(await manageOncall({ action: 'open_pages' }, c), 'T')
  const pages = o.oncall.openPages()
  includes(await manageOncall({ action: 'ack', pageId: pages[0].id, by: 'olu' }, c), 'acknowledged')
  includes(await manageOncall({ action: 'resolve', pageId: pages[0].id }, c), 'resolved')
})

// ─── cost ───
test('get_cost summary + check + list_budgets', async () => {
  const o = makeObs()
  o.cost.record({ model: 'gpt-4o', promptTokens: 1_000_000, completionTokens: 0 })
  const { c } = ctx(o)
  includes(await getCost({ action: 'summary' }, c), '$5')
  includes(await getCost({ action: 'list_budgets' }, c), 'No budgets')
  includes(await getCost({ action: 'check', model: 'gpt-4o' }, c), 'OK')
})

// ─── recording ───
test('manage_recording start/stop/list/export/delete', async () => {
  const o = makeObs()
  const { c } = ctx(o)
  const startOut = await manageRecording({ action: 'start', terminalId: 't1' }, c)
  includes(startOut, 'Recording started')
  const id = startOut.split(': ')[1].trim()
  includes(await manageRecording({ action: 'stop', recordingId: id }, c), 'stopped')
  includes(await manageRecording({ action: 'list' }, c), id)
  includes(await manageRecording({ action: 'export_cast', recordingId: id }, c), '"version":2')
  includes(await manageRecording({ action: 'delete', recordingId: id }, c), 'Deleted')
})

// ─── recording: agent-tool start must register activeRecordings so output is captured ───
test('manage_recording start via agent tool registers the terminal for live capture (regression)', async () => {
  // Use the SAME recorder instance the observability handle exposes, so start/stop/list
  // all hit one SessionRecorder (the agent tool uses o.recording for those).
  const o = makeObs()
  const recorder = o.recording
  const activeRecordings = new Map<string, string>()
  const ts = {
    sessionRecorder: recorder,
    activeRecordings,
    startRecording(terminalId: string, opts: { title?: string } = {}) {
      const id = recorder.start(terminalId, opts)
      activeRecordings.set(terminalId, id)
      return id
    },
    handleData(terminalId: string, data: string) {
      const id = activeRecordings.get(terminalId)
      if (id) recorder.out(id, data)
    },
  }
  const { c } = ctx(o)
  ;(c as unknown as { terminalService: unknown }).terminalService = ts
  const out = await manageRecording({ action: 'start', terminalId: 't-live' }, c)
  const id = out.split(': ')[1].trim()
  // The agent-tool start must have registered the terminal so handleData captures.
  ok(activeRecordings.get('t-live') === id, 'terminal not registered in activeRecordings after agent-tool start')
  ts.handleData('t-live', 'captured-line-1\n')
  const rec = recorder.list().find((x) => x.id === id)
  ok(rec && rec.events === 1, `expected 1 captured event, got ${rec?.events ?? 'none'}`)
  // stop must deregister
  await manageRecording({ action: 'stop', recordingId: id }, c)
  ok(!activeRecordings.has('t-live'), 'terminal still registered after agent-tool stop')
})

// ─── gitops ───
test('manage_gitops export + in_sync', async () => {
  const { c } = ctx(makeObs())
  includes(await manageGitops({ action: 'export' }, c), 'stateHash')
  const m = await (async () => { const o = makeObs(); return o.gitops.exportLive() })()
  includes(await manageGitops({ action: 'in_sync', manifest: m }, c), 'In sync')
})

// ─── playbooks ───
test('manage_playbook_version lint + history', async () => {
  const o = makeObs()
  o.playbooks.versioning.save('pb', { name: 'x', steps: [{ kind: 'command', command: 'ls' }] })
  const { c } = ctx(o)
  includes(await managePlaybookVersion({ action: 'lint', def: { name: 'x', steps: [{ kind: 'command', command: 'ls' }] } }, c), 'clean')
  includes(await managePlaybookVersion({ action: 'history', playbookId: 'pb' }, c), 'v1')
})

// ─── cloud ───
test('get_cloud_inventory summary', async () => {
  const { c } = ctx(makeObs())
  includes(await getCloudInventory({ action: 'summary' }, c), 'Cloud inventory')
})

// ─── live dashboard ───
test('get_live_dashboard state + subscribers', async () => {
  const { c } = ctx(makeObs())
  includes(await getLiveDashboard({ action: 'state' }, c), '2 hosts')
  includes(await getLiveDashboard({ action: 'subscribers' }, c), '0 dashboard subscriber')
})

test('get_monitor_status summary (default) + report (json)', async () => {
  const { c } = ctx(makeObs())
  const summary = await getMonitorStatus({}, c)
  includes(summary, 'publisher=wired')
  includes(summary, 'no_monitor_session')
  const report = await getMonitorStatus({ format: 'report' }, c)
  const parsed = JSON.parse(report) as { publisherWired: boolean; entries: Array<{ diagnosis: string }> }
  ok(parsed.publisherWired === true, 'report publisherWired')
  ok(parsed.entries[0]?.diagnosis === 'no_monitor_session', 'report diagnosis')
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
