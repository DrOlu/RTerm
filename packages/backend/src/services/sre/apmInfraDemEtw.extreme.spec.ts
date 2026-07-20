import { SpanLedger, parseOtlpJson, ingestOtlp, type Span } from '../apm/spanLedger'
import { InfraMonitor, parseKubectlPods, clusterHealth, podUnhealthy, type K8sPod, type K8sNode } from '../infra/infraMonitor'
import { RumLedger } from '../dem/rumLedger'
import {
  EtwService, ETW_PROVIDERS, buildStartCommands, buildStopCommands, buildWinEventQuery,
  buildCounterQuery, parseWinEventJson, parseWinEventText, extractFields, parseCounterJson, topCounters,
} from '../etw/etwService'

const cases: Array<{ name: string; run: () => void | Promise<void> }> = []
function test(n: string, r: () => void | Promise<void>) { cases.push({ name: n, run: r }) }
let T = 1_000_000
const now = () => T

function span(o: Partial<Span> & Pick<Span, 'traceId' | 'service' | 'durationMs'>): Span {
  return { spanId: o.spanId ?? `sp-${Math.random().toString(36).slice(2, 8)}`, name: o.name ?? 'op', startMs: o.startMs ?? T, status: 'ok', ...o }
}

// ---- APM: SpanLedger ----
test('apm: ingest + summarize a trace (root, duration, error)', () => {
  const l = new SpanLedger({ now })
  l.ingest(span({ traceId: 't1', service: 'api', durationMs: 100, startMs: T }))
  l.ingest(span({ traceId: 't1', service: 'db', durationMs: 50, startMs: T + 100, parentSpanId: 'x' }))
  l.ingest(span({ traceId: 't1', service: 'db', durationMs: 20, startMs: T + 150, parentSpanId: 'x', status: 'error' }))
  const s = l.summarize('t1')!
  if (s.spanCount !== 3) throw new Error(`spanCount ${s.spanCount}`)
  if (s.totalDurationMs !== 170) throw new Error(`duration ${s.totalDurationMs}`)
  if (!s.hasError) throw new Error('should have error')
  if (!s.services.includes('api') || !s.services.includes('db')) throw new Error('services')
})
test('apm: serviceStats computes percentiles + error rate', () => {
  const l = new SpanLedger({ now })
  for (let i = 0; i < 10; i += 1) l.ingest(span({ traceId: `t${i}`, service: 'api', durationMs: 100 + i * 10, status: i < 2 ? 'error' : 'ok' }))
  const stats = l.serviceStats()
  const api = stats.find((s) => s.service === 'api')!
  if (api.spanCount !== 10) throw new Error('count')
  if (api.errorCount !== 2 || Math.abs(api.errorRate - 0.2) > 1e-9) throw new Error('errorRate')
  if (api.p95Ms === undefined || api.maxMs !== 190) throw new Error('percentiles')
})
test('apm: slowestTraces ranks by total duration', () => {
  const l = new SpanLedger({ now })
  l.ingest(span({ traceId: 'slow', service: 'api', durationMs: 500 }))
  l.ingest(span({ traceId: 'fast', service: 'api', durationMs: 10 }))
  const slow = l.slowestTraces(1)
  if (slow[0].traceId !== 'slow') throw new Error('slowest wrong')
})
test('apm: bottleneckServices ranks by error count', () => {
  const l = new SpanLedger({ now })
  for (let i = 0; i < 3; i += 1) l.ingest(span({ traceId: `a${i}`, service: 'payments', durationMs: 10, status: 'error' }))
  l.ingest(span({ traceId: 'b', service: 'api', durationMs: 10, status: 'ok' }))
  const b = l.bottleneckServices()
  if (b[0].service !== 'payments') throw new Error('bottleneck wrong')
})
test('apm: ring buffer drops oldest traces over spanLimit', () => {
  const l = new SpanLedger({ now, spanLimit: 4 })
  for (let i = 0; i < 6; i += 1) l.ingest(span({ traceId: `t${i}`, service: 's', durationMs: 1 }))
  if (l.size() > 4) throw new Error(`size ${l.size()} should respect limit`)
})
test('apm: parseOtlpJson parses OTLP/HTTP JSON into spans', () => {
  const payload = {
    resourceSpans: [{
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'checkout' } }] },
      scopeSpans: [{ spans: [{
        traceId: 'abc', spanId: 's1', name: 'POST /pay',
        startTimeUnixNano: '1000000000', endTimeUnixNano: '2000000000',
        status: { code: 2 },
      }] }],
    }],
  }
  const spans = parseOtlpJson(payload)
  if (spans.length !== 1) throw new Error(`parsed ${spans.length}`)
  const s = spans[0]
  if (s.service !== 'checkout' || s.traceId !== 'abc') throw new Error('service/trace')
  if (s.durationMs !== 1000) throw new Error(`duration ${s.durationMs}`)
  if (s.status !== 'error') throw new Error('status should be error')
})
test('apm: ingestOtlp ingests and returns count', () => {
  const l = new SpanLedger({ now })
  const payload = { resourceSpans: [{ scopeSpans: [{ spans: [{ traceId: 'x', spanId: 'y', startTimeUnixNano: '1000000000', endTimeUnixNano: '1100000000' }] }] }] }
  const n = ingestOtlp(l, payload)
  if (n !== 1) throw new Error(`ingested ${n}`)
  if (l.size() !== 1) throw new Error('ledger size')
})

// ---- Infra: InfraMonitor ----
test('infra: parseKubectlPods parses kubectl text rows', () => {
  const text = 'NAME                          READY   STATUS    RESTARTS   AGE\n' +
    'web-7d9f5                     1/1     Running   0          5d\n' +
    'api-6c8f4                     0/1     Pending   3          2d\n' +
    'cache-5b7a2                   1/1     Failed    12         1d\n'
  const pods = parseKubectlPods(text)
  if (pods.length !== 3) throw new Error(`pods ${pods.length}`)
  if (!pods[0].ready) throw new Error('web should be ready')
  if (pods[1].ready) throw new Error('api should not be ready')
  if (pods[2].restarts !== 12) throw new Error('restarts')
})
test('infra: clusterHealth derives running/notReady/crashLoop/restarts/nodes', () => {
  const pods: K8sPod[] = [
    { name: 'a', namespace: 'd', phase: 'Running', restarts: 0, ready: true },
    { name: 'b', namespace: 'd', phase: 'Pending', restarts: 2, ready: false },
    { name: 'c', namespace: 'd', phase: 'Running', restarts: 9, ready: false },
  ]
  const nodes: K8sNode[] = [{ name: 'n1', ready: true }, { name: 'n2', ready: false }]
  const h = clusterHealth('prod', pods, nodes)
  if (h.totalPods !== 3 || h.runningPods !== 2) throw new Error('running')
  if (h.notReadyPods !== 2) throw new Error('notReady')
  if (h.crashLoopPods !== 1) throw new Error('crashLoop')
  if (h.totalRestarts !== 11) throw new Error('restarts')
  if (h.nodesReady !== 1 || h.nodesTotal !== 2) throw new Error('nodes')
})
test('infra: clusterHealth computes cpu/mem % of limit', () => {
  const pods: K8sPod[] = [
    { name: 'a', namespace: 'd', phase: 'Running', restarts: 0, ready: true, cpuMillicores: 500, cpuLimitMillicores: 1000, memMiB: 256, memLimitMiB: 512 },
  ]
  const h = clusterHealth('prod', pods, [])
  if (Math.abs((h.cpuUsagePercentOfLimit ?? 0) - 50) > 1e-9) throw new Error('cpu pct')
  if (Math.abs((h.memUsagePercentOfLimit ?? 0) - 50) > 1e-9) throw new Error('mem pct')
})
test('infra: podUnhealthy flags not-ready/failed/unknown/high-restarts', () => {
  if (podUnhealthy({ name: 'a', namespace: 'd', phase: 'Running', restarts: 0, ready: true })) throw new Error('healthy should be false')
  if (!podUnhealthy({ name: 'a', namespace: 'd', phase: 'Running', restarts: 6, ready: true })) throw new Error('high restarts')
  if (!podUnhealthy({ name: 'a', namespace: 'd', phase: 'Failed', restarts: 0, ready: false })) throw new Error('failed')
})
test('infra: recordCluster + unhealthyInstances', () => {
  const m = new InfraMonitor({ now })
  m.recordCluster('prod', [{ name: 'a', namespace: 'd', phase: 'Running', restarts: 0, ready: true }], [{ name: 'n1', ready: true }])
  if (m.cluster('prod')!.totalPods !== 1) throw new Error('cluster')
  m.recordInstance({ id: 'i-1', state: 'running', statusOk: true })
  m.recordInstance({ id: 'i-2', state: 'stopped', statusOk: false })
  const bad = m.unhealthyInstances()
  if (bad.length !== 1 || bad[0].id !== 'i-2') throw new Error('unhealthy instances')
})

// ---- DEM: RumLedger ----
test('dem: ingest + pageStats computes p75 LCP/INP + error rate', () => {
  const l = new RumLedger({ now })
  const lcps = [1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500]
  for (const v of lcps) l.ingest({ page: '/checkout', lcpMs: v, inpMs: v / 10 })
  l.ingest({ page: '/checkout', lcpMs: 5000, jsErrors: 3 })
  const stats = l.pageStats()
  const p = stats.find((s) => s.page === '/checkout')!
  if (p.sessions !== 9) throw new Error('sessions')
  if (p.p75LcpMs === undefined) throw new Error('p75 missing')
  if (Math.abs(p.errorRate - (1 / 9)) > 1e-9) throw new Error(`errorRate ${p.errorRate}`)
})
test('dem: ingestBeacon parses the beacon payload', () => {
  const l = new RumLedger({ now })
  const s = l.ingestBeacon({ page: '/home', lcpMs: 1800, inpMs: 120, cls: 0.05, ttfbMs: 300, region: 'us-east' })!
  if (!s || s.page !== '/home' || s.lcpMs !== 1800) throw new Error('beacon parse')
  if (s.region !== 'us-east') throw new Error('region')
})
test('dem: poorPages flags pages over the LCP threshold', () => {
  const l = new RumLedger({ now })
  for (let i = 0; i < 5; i += 1) l.ingest({ page: '/slow', lcpMs: 4000 })
  for (let i = 0; i < 5; i += 1) l.ingest({ page: '/fast', lcpMs: 800 })
  const poor = l.poorPages(2500)
  if (poor.length !== 1 || poor[0].page !== '/slow') throw new Error(`poor ${JSON.stringify(poor)}`)
})
test('dem: slowestPages ranks by p75 LCP', () => {
  const l = new RumLedger({ now })
  for (let i = 0; i < 5; i += 1) l.ingest({ page: '/a', lcpMs: 5000 })
  for (let i = 0; i < 5; i += 1) l.ingest({ page: '/b', lcpMs: 1000 })
  const slow = l.slowestPages(1)
  if (slow[0].page !== '/a') throw new Error('slowest wrong')
})
test('dem: beacon rejects invalid payload (no page)', () => {
  const l = new RumLedger({ now })
  if (l.ingestBeacon({ lcpMs: 100 }) !== undefined) throw new Error('should reject no-page beacon')
})

// ---- ETW: EtwService + builders/parsers ----
test('etw: providers catalog has network/file/registry/process', () => {
  if (!ETW_PROVIDERS.network || !ETW_PROVIDERS.file || !ETW_PROVIDERS.registry || !ETW_PROVIDERS.process) throw new Error('providers missing')
})
test('etw: createSession sanitizes name + builds start/stop commands', () => {
  const svc = new EtwService({ now })
  const s = svc.createSession('my diag!', ['network', 'file'])
  if (s.name !== 'mydiag') throw new Error(`name ${s.name}`)
  const start = buildStartCommands(s)
  if (start.length !== 2) throw new Error('start cmds')
  if (!start[0].includes('logman create trace') || !start[0].includes('Microsoft-Windows-Kernel-Network')) throw new Error('start cmd content')
  const stop = buildStopCommands(s)
  if (stop.length !== 2 || !stop[0].includes('logman stop')) throw new Error('stop cmds')
})
test('etw: buildWinEventQuery produces Get-WinEvent JSON command', () => {
  const q = buildWinEventQuery('Security', 50, "$_.Id -eq 4625")
  if (!q.includes("Get-WinEvent -LogName 'Security' -MaxEvents 50")) throw new Error('query base')
  if (!q.includes('ConvertTo-Json') || !q.includes('Where-Object')) throw new Error('query json/filter')
})
test('etw: buildCounterQuery produces Get-Counter JSON command', () => {
  const q = buildCounterQuery('\\Process(*)\\% Processor Time', 3)
  if (!q.includes('Get-Counter') || !q.includes('-MaxSamples 3')) throw new Error('counter query')
  if (!q.includes('ConvertTo-Json')) throw new Error('counter json')
})
test('etw: parseWinEventJson parses array + single-object JSON', () => {
  const arr = JSON.stringify([
    { TimeCreated: '2026-07-20T10:00:00Z', Id: 4624, ProviderName: 'Security', Message: 'Logon from 10.0.0.5 port 22' },
  ])
  const ev = parseWinEventJson(arr)
  if (ev.length !== 1) throw new Error('array parse')
  if (ev[0].fields?.ip !== '10.0.0.5') throw new Error('ip extraction')
  const single = JSON.stringify({ TimeCreated: '2026-07-20T10:00:00Z', Id: 1, ProviderName: 'X', Message: 'single event' })
  const ev2 = parseWinEventJson(single)
  if (ev2.length !== 1) throw new Error('single parse')
})
test('etw: extractFields pulls ip/port/path/key/process/pid', () => {
  const f = extractFields('ProcessName: w3wp.exe Process Id: 4521 connecting to 192.168.1.10 port: 443 path C:\\inetpub\\app\\web.config key HKLM\\SOFTWARE\\App\\Key')
  if (f.processName !== 'w3wp.exe') throw new Error('process')
  if (f.pid !== '4521') throw new Error('pid')
  if (f.ip !== '192.168.1.10') throw new Error('ip')
  if (f.port !== '443') throw new Error('port')
  if (!f.path || !f.path.startsWith('C:\\')) throw new Error('path')
  if (!f.key || !f.key.startsWith('HKLM')) throw new Error('key')
})
test('etw: parseWinEventText parses text blocks (fallback)', () => {
  const text = 'Event 1 connecting to 10.0.0.1 port 80\nmore detail\n\nEvent 2 reading C:\\temp\\x.txt'
  const ev = parseWinEventText(text)
  if (ev.length !== 2) throw new Error(`text parse ${ev.length}`)
  if (ev[0].fields?.ip !== '10.0.0.1') throw new Error('text ip')
})
test('etw: parseCounterJson parses {path,value} points', () => {
  const out = JSON.stringify([
    { Path: '\\\\h\\process(w3wp)\\% processor time', CookedValue: 45.5 },
    { Path: '\\\\h\\process(idle)\\% processor time', CookedValue: 99.0 },
  ])
  const pts = parseCounterJson(out)
  if (pts.length !== 2) throw new Error('counter parse')
  if (Math.abs(pts[1].value - 99.0) > 1e-9) throw new Error('value')
})
test('etw: topCounters ranks by value', () => {
  const top = topCounters([
    { path: 'a', value: 10 }, { path: 'b', value: 90 }, { path: 'c', value: 50 },
  ], 2)
  if (top[0].path !== 'b' || top.length !== 2) throw new Error('top counters')
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
