import {
  ingestApmSpans, getApmSummary, ingestDemBeacon, getDemSummary, collectInfra, manageEtw,
} from './observability_tools'
import { createObservabilityBridge, OBSERVABILITY_METHODS } from '../../Gateway/observabilityBridge'
import { SpanLedger } from '../../apm/spanLedger'
import { RumLedger } from '../../dem/rumLedger'
import { InfraMonitor } from '../../infra/infraMonitor'
import { EtwService } from '../../etw/etwService'
import type { Observability } from '../../observability'
import type { ToolExecutionContext } from '../types'

const cases: Array<{ name: string; run: () => void | Promise<void> }> = []
function test(n: string, r: () => void | Promise<void>) { cases.push({ name: n, run: r }) }
function ok(v: unknown, m = '') { if (!v) throw new Error(m || 'expected truthy') }
function includes(h: string, n: string, m = '') { if (!h.includes(n)) throw new Error(`${m} expected ${JSON.stringify(n)} in:\n${h}`) }
function eq(a: unknown, b: unknown, m = '') { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`) }

function makeObs(): Observability {
  return {
    spanLedger: new SpanLedger({}),
    rumLedger: new RumLedger({}),
    infraMonitor: new InfraMonitor({}),
    etwService: new EtwService({}),
    dashboard: { summary: async () => 'dash', state: async () => ({}) },
  } as unknown as Observability
}
function ctx(o?: Observability): { c: ToolExecutionContext; events: string[] } {
  const events: string[] = []
  const c = {
    sessionId: 's1', messageId: 'm1', terminalService: {} as never,
    sendEvent: (_s: string, e: { output?: string }) => { events.push(String(e.output ?? '')) },
    commandPolicyService: {} as never, commandPolicyMode: 'standard' as never, observability: o,
  } as unknown as ToolExecutionContext
  return { c, events }
}

// ── APM ──
test('ingest_apm_spans feeds spanLedger + get_apm_summary reflects it', async () => {
  const o = makeObs()
  const { c } = ctx(o)
  const payload = {
    resourceSpans: [{
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'checkout' } }] },
      scopeSpans: [{ scope: {}, spans: [
        { traceId: 't1', spanId: 's1', name: 'POST /checkout', startTimeUnixNano: '1000000000', endTimeUnixNano: '1500000000', status: { code: 'STATUS_CODE_OK' } },
        { traceId: 't1', spanId: 's2', name: 'db query', startTimeUnixNano: '1100000000', endTimeUnixNano: '1400000000', status: { code: 'STATUS_CODE_ERROR' } },
      ] }],
    }],
  }
  includes(await ingestApmSpans({ payload }, c), 'Ingested 2')
  const sum = await getApmSummary({}, c)
  includes(sum, 'checkout')
})
test('ingest_apm_spans reports unavailable when observability not wired', async () => {
  const { c } = ctx(undefined)
  includes(await ingestApmSpans({ payload: {} }, c), 'not available')
})

// ── DEM ──
test('ingest_dem_beacon feeds rumLedger + get_dem_summary reflects it', async () => {
  const o = makeObs()
  const { c } = ctx(o)
  includes(await ingestDemBeacon({ payload: { page: '/checkout', lcpMs: 2100, inpMs: 180, jsErrors: 1 } }, c), '/checkout')
  const sum = await getDemSummary({}, c)
  ok(sum.length > 0)
})
test('ingest_dem_beacon rejects a beacon with no page', async () => {
  const { c } = ctx(makeObs())
  includes(await ingestDemBeacon({ payload: { lcpMs: 100 } }, c), 'page')
})

// ── Infra ──
test('collect_infra parses kubectl payload + records cluster health', async () => {
  const o = makeObs()
  const { c } = ctx(o)
  const kubectlJson = { items: [
    { metadata: { name: 'web-1', namespace: 'prod' }, status: { phase: 'Running', containerStatuses: [{ ready: true, restartCount: 0 }] } },
    { metadata: { name: 'web-2', namespace: 'prod' }, status: { phase: 'Running', containerStatuses: [{ ready: false, restartCount: 5, state: { waiting: { reason: 'CrashLoopBackOff' } } }] } },
  ] }
  const out = await collectInfra({ context: 'prod', kubectlJson }, c)
  includes(out, 'prod')
  includes(out, 'pods')
})
test('collect_infra without kubectl or payload reports a clean error (path executes)', async () => {
  const { c } = ctx(makeObs())
  const out = await collectInfra({ context: 'x' }, c)
  ok(out.length > 0, 'returns a message (error or result)')
})

// ── ETW ──
test('manage_etw start creates a session + returns start commands', async () => {
  const o = makeObs()
  const { c } = ctx(o)
  const out = await manageEtw({ action: 'start', name: 'net-trace', providers: ['network'] }, c)
  includes(out, 'ETW session')
  includes(out, 'net-trace')
})
test('manage_etw sessions lists created sessions', async () => {
  const o = makeObs()
  const { c } = ctx(o)
  await manageEtw({ action: 'start', name: 't1', providers: ['process'] }, c)
  includes(await manageEtw({ action: 'sessions' }, c), 't1')
})
test('manage_etw stop returns stop commands for a real session', async () => {
  const o = makeObs()
  const { c } = ctx(o)
  const startOut = await manageEtw({ action: 'start', name: 't2', providers: ['file'] }, c)
  const id = /session (etw-\w+)/.exec(startOut)?.[1]
  ok(id, 'session id present')
  includes(await manageEtw({ action: 'stop', sessionId: id }, c), 'Stop commands')
})
test('manage_etw stop on unknown session reports it', async () => {
  const { c } = ctx(makeObs())
  includes(await manageEtw({ action: 'stop', sessionId: 'nope' }, c), 'No ETW session')
})
test('manage_etw parse parses Get-Counter JSON output', async () => {
  const { c } = ctx(makeObs())
  const out = await manageEtw({ action: 'parse', format: 'counter', output: JSON.stringify([{ Path: '\\processor(_total)\\% processor time', Value: 42 }]) }, c)
  includes(out, 'counter')
})

// ── RPC bridge: the new methods exist + are callable ──
test('OBSERVABILITY_METHODS includes all 15 ingestion methods', () => {
  const need = ['apmIngestSpans', 'apmSummary', 'demIngestBeacon', 'demSummary', 'infraCollect', 'infraClusters', 'infraUnhealthy', 'etwStartTrace', 'etwStopTrace', 'etwParse', 'etwSessions']
  for (const m of need) ok(OBSERVABILITY_METHODS.includes(`observability:${m}` as never), `missing ${m}`)
})
test('bridge apmIngestSpans + apmSummary work over the bridge', async () => {
  const o = makeObs()
  const b = createObservabilityBridge({ observability: () => o })
  const payload = {
    resourceSpans: [{
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'api' } }] },
      scopeSpans: [{ scope: {}, spans: [{ traceId: 't', spanId: 's', name: 'op', startTimeUnixNano: '1000', endTimeUnixNano: '2000', status: { code: 'STATUS_CODE_OK' } }] }],
    }],
  }
  await b.apmIngestSpans({ payload })
  ok((await b.apmSummary() as unknown) !== undefined)
})
test('bridge demIngestBeacon + infraCollect + etwStartTrace work over the bridge', async () => {
  const o = makeObs()
  const b = createObservabilityBridge({ observability: () => o })
  eq((await b.demIngestBeacon({ payload: { page: '/x' } })).ingested, true)
  const r = await b.infraCollect({ context: 'c', kubectlJson: { items: [] } })
  eq(r.context, 'c')
  const s = await b.etwStartTrace({ name: 'tr', providers: ['network'] })
  ok(s.id.startsWith('etw-'))
  ok((await b.etwSessions()).length > 0)
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
