import { createObservabilityBridge, OBSERVABILITY_METHODS } from './observabilityBridge'
import { PrometheusRegistry, registryFromHostMetrics } from '../sre/prometheusExporter'
import { SecretsVault } from '../secrets/secretsVault'
import { EscalationService } from '../oncall/escalationService'
import { CostBudgetService } from '../cost/costBudgetService'
import { SessionRecorder } from '../recording/sessionRecorder'
import { GitOpsService } from '../gitops/gitOpsService'
import { PlaybookVersioning, lintPlaybook, lintOk } from '../automation/playbookVersioning'
import { CloudInventory } from '../cloud/cloudInventory'
import { LiveDashboardHub } from '../liveui/liveDashboardHub'
import type { Observability } from '../observability'

const cases: Array<{ name: string; run: () => void | Promise<void> }> = []
function test(n: string, r: () => void | Promise<void>) { cases.push({ name: n, run: r }) }
function eq(a: unknown, b: unknown, m = '') { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`) }
function ok(v: unknown, m = '') { if (!v) throw new Error(m || 'expected truthy') }
function includes(h: string, n: string, m = '') { if (!h.includes(n)) throw new Error(`${m} expected ${JSON.stringify(n)} in output`) }
async function throwsAsync(fn: () => Promise<unknown>, m = '') { let t = false; try { await fn() } catch { t = true } if (!t) throw new Error(m || 'expected throw') }

// Build a minimal but real Observability for testing the bridge end-to-end.
function makeObs(): Observability {
  const registry = new PrometheusRegistry()
  const metricsLedger = {
    hosts: () => ['web-01'],
    latest: (h: string) => (h === 'web-01' ? { host: 'web-01', at: 1, cpuUsagePercent: 42 } : undefined),
    record: () => ({}),
  }
  return {
    metricsLedger: metricsLedger as never,
    goldenSignals: {} as never,
    sloService: {} as never,
    uptimeWatchdog: {} as never,
    alertService: {} as never,
    incidentLedger: {} as never,
    syntheticChecks: {} as never,
    driftDetector: {} as never,
    spanLedger: {} as never,
    rumLedger: {} as never,
    infraMonitor: {} as never,
    etwService: {} as never,
    dashboard: {
      state: async () => ({ hosts: ['web-01'] }),
      summary: async () => '1 host, 0 down, 0 incidents',
    } as never,
    evalHarness: {} as never,
    anomalyDetector: {} as never,
    earlyWarning: {} as never,
    behaviorLedger: {} as never,
    dagu: {} as never,
    notify: {} as never,
    aperf: {} as never,
    audit: {} as never,
    monitorStatus: {} as never,
    governance: {} as never,
    review: {} as never,
    pluginRegistry: {} as never,
    metricsExport: {
      registry,
      otel: null,
      registryFromHostMetrics,
      renderPrometheus: () => {
        const r = registryFromHostMetrics([{ host: 'web-01', metric: 'host_cpuUsagePercent', value: 42 }], { prefix: 'rterm' })
        return r.render()
      },
    },
    secrets: new SecretsVault({ masterKey: 'pw' }),
    oncall: new EscalationService(),
    cost: new CostBudgetService({ prices: { m: { promptPer1M: 1, completionPer1M: 2 } } }),
    recording: new SessionRecorder(),
    gitops: new GitOpsService({ readLive: () => [] }),
    playbooks: { versioning: new PlaybookVersioning(), lint: lintPlaybook, lintOk },
    cloud: new CloudInventory(),
    liveDashboard: new LiveDashboardHub({ getState: () => ({ hosts: ['web-01'] }) }),
  } as unknown as Observability
}

function bridge() {
  const o = makeObs()
  return createObservabilityBridge({ observability: () => o })
}

// ─── method surface ───
test('OBSERVABILITY_METHODS covers all 41 methods with observability: prefix', () => {
  eq(OBSERVABILITY_METHODS.length, 41)
  ok(OBSERVABILITY_METHODS.every((m) => m.startsWith('observability:')))
  // every method name maps to a bridge fn
  const b = bridge() as Record<string, unknown>
  for (const m of OBSERVABILITY_METHODS) {
    const fn = m.slice('observability:'.length)
    ok(typeof b[fn] === 'function', `bridge missing fn for ${m}`)
  }
})
test('bridge throws a clear error when observability is unavailable', async () => {
  const b = createObservabilityBridge({ observability: () => null })
  await throwsAsync(() => b.dashboardState())
})

// ─── metrics ───
test('metricsPrometheus renders exposition text', async () => {
  const out = await bridge().metricsPrometheus()
  includes(out, 'rterm_host_cpuUsagePercent{host="web-01"} 42')
})
test('dashboardState + dashboardSummary', async () => {
  const b = bridge()
  eq((await b.dashboardState() as any).hosts, ['web-01'])
  includes(await b.dashboardSummary(), '1 host')
})

// ─── secrets (metadata only, never values) ───
test('secrets set/has/list/delete (values never returned)', async () => {
  const b = bridge()
  await b.secretsSet({ key: 'api-key', value: 'supersecret', labels: { svc: 'aws' } })
  eq((await b.secretsHas({ key: 'api-key' })).exists, true)
  const list = await b.secretsList({}) as any[]
  eq(list[0].key, 'api-key')
  ok(!('blob' in list[0]) && !('value' in list[0]), 'no value/blob in metadata')
  ok(JSON.stringify(list).indexOf('supersecret') === -1, 'plaintext never in list output')
  eq((await b.secretsDelete({ key: 'api-key' })).deleted, true)
  eq((await b.secretsHas({ key: 'api-key' })).exists, false)
})

// ─── on-call ───
test('oncall register policy → page → openPages → ack → tick → resolve', async () => {
  const b = bridge()
  await b.oncallRegisterPolicy({
    id: 'p1', name: 'primary',
    levels: [{ targets: [{ id: '@a', channel: 'slack' }], ackTimeoutMs: 1000 }],
  })
  eq((await b.oncallListPolicies() as any[]).length, 1)
  const page = await b.oncallPage({ incidentId: 'i1', policyId: 'p1', title: 'DB down', severity: 'sev1' }) as any
  eq(page.status, 'open')
  eq((await b.oncallOpenPages() as any[]).length, 1)
  await b.oncallAck({ pageId: page.id, by: 'olu' })
  eq((await b.oncallOpenPages() as any[]).length, 0)
  await b.oncallResolve({ pageId: page.id })
  const t = await b.oncallTick() as any[]
  eq(t.length, 0) // acked+resolved, nothing to escalate
})

// ─── cost ───
test('cost record → summary → check → budgets', async () => {
  const b = bridge()
  await b.costRecord({ model: 'm', promptTokens: 1_000_000, completionTokens: 1_000_000 })
  const sum = await b.costSummary({ period: 'daily' }) as any
  ok(sum.totalUsd > 0)
  await b.costSetBudget({ id: 'b1', model: '*', period: 'daily', capUsd: 0.0001, overAction: 'deny' })
  const chk = await b.costCheck({ model: 'm' }) as any
  eq(chk.action, 'deny')
  eq((await b.costListBudgets() as any[]).length, 1)
  eq((await b.costRemoveBudget({ id: 'b1' })).removed, true)
})

// ─── recording ───
test('recording start → stop → list → replay → exportCast → delete', async () => {
  const b = bridge()
  const { recordingId } = await b.recordingStart({ terminalId: 't1', title: 'demo' }) as any
  ok(recordingId)
  // record an event via the underlying service is not exposed; stop directly
  const rec = await b.recordingStop({ recordingId }) as any
  ok(rec.endedAt !== undefined)
  const list = await b.recordingList() as any[]
  eq(list.length, 1)
  const cast = await b.recordingExportCast({ recordingId })
  includes(cast, '"version":2')
  eq((await b.recordingDelete({ recordingId })).deleted, true)
})
test('recordingReplay on a stopped recording returns events', async () => {
  const b = bridge()
  const { recordingId } = await b.recordingStart({ terminalId: 't1' }) as any
  await b.recordingStop({ recordingId })
  const ev = await b.recordingReplay({ recordingId }) as any[]
  ok(Array.isArray(ev))
})

// ─── gitops ───
test('gitops export → drift → inSync', async () => {
  const b = bridge()
  const m = await b.gitopsExport() as any
  ok(m.stateHash)
  eq((await b.gitopsDrift({ manifest: m }) as any[]).length, 0)
  eq((await b.gitopsInSync({ manifest: m })).inSync, true)
})

// ─── playbooks ───
test('playbook lint → save → history → diff → rollback', async () => {
  const b = bridge()
  const clean = await b.playbookLint({ def: { name: 'x', steps: [{ kind: 'command', command: 'ls' }] } }) as any[]
  eq(clean.length, 0)
  await b.playbookSave({ playbookId: 'pb', def: { name: 'x', steps: [{ kind: 'command', command: 'ls' }] } })
  await b.playbookSave({ playbookId: 'pb', def: { name: 'x2', steps: [{ kind: 'command', command: 'ls' }] } })
  eq((await b.playbookHistory({ playbookId: 'pb' }) as any[]).length, 2)
  const d = await b.playbookDiff({ playbookId: 'pb', a: 1, b: 2 })
  includes(d, 'x2')
  const r = await b.playbookRollback({ playbookId: 'pb', version: 1 }) as any
  eq(r.version, 3)
})

// ─── cloud ───
test('cloud addAccount → summary → query → sync (no fetcher → error tolerated)', async () => {
  const b = bridge()
  await b.cloudAddAccount({ provider: 'aws', accountId: '1111' })
  const s = await b.cloudSummary() as any
  eq(s.total, 0)
  eq((await b.cloudQuery({}) as any[]).length, 0)
  const r = await b.cloudSync() as any
  eq(r.errors.length, 1) // no AWS fetcher injected → best-effort error
})

// ─── live dashboard ───
test('liveDashboardState + subscriberCount', async () => {
  const b = bridge()
  eq((await b.liveDashboardSubscriberCount()).count, 0)
  const st = await b.liveDashboardState() as any
  ok(st)
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
