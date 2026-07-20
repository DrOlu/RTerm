import { MetricsLedger, flattenSnapshot } from './metricsLedger'
import { UptimeWatchdog } from './uptimeWatchdog'
import { SloService } from './sloService'
import { AlertService } from './alertService'
import { IncidentLedger } from './incidentLedger'
import { GoldenSignals } from './goldenSignals'
import { SyntheticChecks } from './syntheticChecks'
import { DriftDetector, diffConfigs } from './driftDetector'
import type { ResourceSnapshot } from '../../types'

const cases: Array<{ name: string; run: () => void | Promise<void> }> = []
function test(n: string, r: () => void | Promise<void>) { cases.push({ name: n, run: r }) }
let T = 1_000_000
const now = () => T
const day = 86_400_000

function snap(at: number, cpu = 50, mem = 60, disk = 70): ResourceSnapshot {
  return {
    timestamp: at, terminalId: 'h',
    cpu: { usagePercent: cpu },
    memory: { totalBytes: 1e9, usedBytes: 6e8, availableBytes: 4e8, usagePercent: mem },
    disks: [{ filesystem: 'fs', mountPoint: '/', totalBytes: 1e9, usedBytes: 7e8, availableBytes: 3e8, usagePercent: disk }],
    loadAverage: [cpu / 10, 1, 1],
    network: [{ interface: 'eth0', rxBytesPerSec: 1000, txBytesPerSec: 2000 }],
    uptimeSeconds: 1000,
  } as unknown as ResourceSnapshot
}

// ---- MetricsLedger ----
test('metrics: flattenSnapshot maps cpu/mem/disk/net/load', () => {
  const p = flattenSnapshot('h1', snap(1000, 42, 55, 66))
  if (p.cpuUsagePercent !== 42 || p.memoryUsagePercent !== 55 || p.diskUsagePercentMax !== 66) throw new Error('flatten wrong')
  if (p.netRxBytesPerSec !== 1000 || p.netTxBytesPerSec !== 2000) throw new Error('net wrong')
  if (p.loadAvg1 !== 4.2) throw new Error('load wrong')
})
test('metrics: record + latest + hosts', () => {
  const l = new MetricsLedger({ now })
  l.record('h1', snap(1000))
  l.record('h2', snap(2000))
  if (l.hosts().length !== 2) throw new Error('hosts')
  if (!l.latest('h1')) throw new Error('latest')
})
test('metrics: ring buffer respects perHostLimit', () => {
  const l = new MetricsLedger({ perHostLimit: 3, now })
  for (let i = 0; i < 5; i += 1) l.record('h', snap(i * 1000))
  if (l.series('h').length !== 3) throw new Error('limit not applied')
})
test('metrics: trendSlopePerDay rises for increasing cpu', () => {
  const l = new MetricsLedger({ now })
  for (let d = 0; d < 10; d += 1) l.record('h', snap(T + d * day, 10 + d * 5))
  const slope = l.trendSlopePerDay('h', 'cpuUsagePercent')
  if (slope === undefined || slope <= 0) throw new Error(`slope ${slope}`)
  if (Math.abs(slope - 5) > 0.5) throw new Error(`slope should be ~5/day, got ${slope}`)
})
test('metrics: daysUntilThreshold computes days to full', () => {
  const l = new MetricsLedger({ now })
  for (let d = 0; d < 10; d += 1) l.record('h', snap(T + d * day, 50, 50, 40 + d * 2))
  const days = l.daysUntilThreshold('h', 'diskUsagePercentMax', 95)
  if (days === undefined || days <= 0) throw new Error(`days ${days}`)
})

// ---- UptimeWatchdog ----
test('watchdog: up when probe succeeds', async () => {
  const wd = new UptimeWatchdog({ probeTcp: async () => true, now })
  const t = wd.upsert({ name: 'web-1', kind: 'tcp', address: 'web-1', expect: 443 })
  const st = await wd.probe(t.id)
  if (st.state !== 'up') throw new Error(`state ${st.state}`)
})
test('watchdog: degraded after one failure, down after downAfter', async () => {
  const wd = new UptimeWatchdog({ probeTcp: async () => false, now })
  const t = wd.upsert({ name: 'web-1', kind: 'tcp', address: 'web-1', downAfter: 3 })
  await wd.probe(t.id); await wd.probe(t.id)
  if (wd.getStatus(t.id)!.state !== 'degraded') throw new Error('should be degraded')
  await wd.probe(t.id)
  if (wd.getStatus(t.id)!.state !== 'down') throw new Error('should be down')
})
test('watchdog: fires onTransition on state change', async () => {
  const transitions: string[] = []
  let ok = true
  const wd = new UptimeWatchdog({ probeTcp: async () => ok, now, onTransition: (_s, from, to) => transitions.push(`${from}->${to}`) })
  const t = wd.upsert({ name: 'web-1', kind: 'tcp', address: 'web-1', downAfter: 1 })
  await wd.probe(t.id)
  ok = false
  await wd.probe(t.id)
  if (transitions.length < 2) throw new Error(`transitions ${transitions}`)
})
test('watchdog: http probe matches expected status', async () => {
  const wd = new UptimeWatchdog({ probeHttp: async () => 200, now })
  const t = wd.upsert({ name: 'api', kind: 'http', address: 'https://api/health', expect: 200 })
  const st = await wd.probe(t.id)
  if (st.state !== 'up') throw new Error('http should be up')
})
test('watchdog: probeDue only probes due targets', async () => {
  let probes = 0
  const wd = new UptimeWatchdog({ probeTcp: async () => { probes += 1; return true }, now })
  wd.upsert({ name: 'a', kind: 'tcp', address: 'a', intervalMs: 1000 })
  wd.upsert({ name: 'b', kind: 'tcp', address: 'b', intervalMs: 999999999 })
  const due = await wd.probeDue()
  if (due.length !== 1 || probes !== 1) throw new Error(`due ${due.length} probes ${probes}`)
})

// ---- SloService ----
test('slo: evaluate computes sli, burn rate, budget', async () => {
  const svc = new SloService({ source: { count: async () => ({ good: 999, total: 1000 }) }, now })
  const s = svc.upsert({ name: 'api-uptime', target: 0.999, windowMs: day })
  const e = await svc.evaluate(s.id)
  if (Math.abs((e.sli ?? 0) - 0.999) > 1e-9) throw new Error(`sli ${e.sli}`)
  if (e.burnRate === undefined) throw new Error('burnRate should be defined')
})
test('slo: fastBurning when burn rate exceeds threshold', async () => {
  const svc = new SloService({ source: { count: async () => ({ good: 900, total: 1000 }) }, now })
  const s = svc.upsert({ name: 'api', target: 0.999, windowMs: day })
  const e = await svc.evaluate(s.id)
  // actual error 10% vs allowed 0.1% => burnRate 100 => fast burning
  if (!e.fastBurning) throw new Error(`should be fast burning (burnRate ${e.burnRate})`)
})
test('slo: not fast burning under target', async () => {
  const svc = new SloService({ source: { count: async () => ({ good: 9999, total: 10000 }) }, now })
  const s = svc.upsert({ name: 'api', target: 0.999, windowMs: day })
  const e = await svc.evaluate(s.id)
  if (e.fastBurning) throw new Error('should not be fast burning')
})
test('slo: zero total events -> sli undefined, not burning', async () => {
  const svc = new SloService({ source: { count: async () => ({ good: 0, total: 0 }) }, now })
  const s = svc.upsert({ name: 'api', target: 0.999, windowMs: day })
  const e = await svc.evaluate(s.id)
  if (e.sli !== undefined) throw new Error('sli should be undefined for 0 total')
  if (e.fastBurning) throw new Error('should not burn with 0 events')
})
test('slo: upsert validates target range', () => {
  const svc = new SloService({ source: { count: async () => ({ good: 0, total: 0 }) }, now })
  let threw = false
  try { svc.upsert({ name: 'bad', target: 1.5, windowMs: day }) } catch { threw = true }
  if (!threw) throw new Error('should reject target > 1')
})

// ---- AlertService ----
test('alert: fire routes to channels above min severity', async () => {
  const sent: string[] = []
  const svc = new AlertService({ now, channels: [{ name: 'crit-only', minSeverity: 'critical', send: async (g) => { sent.push(g.title); return 'ok' } }] })
  await svc.fire({ fingerprint: 'a:1', title: 'low', severity: 'info', source: 't', at: T })
  await svc.fire({ fingerprint: 'b:1', title: 'high', severity: 'critical', source: 't', at: T })
  if (sent.length !== 1 || sent[0] !== 'high') throw new Error(`sent ${JSON.stringify(sent)}`)
})
test('alert: dedupe groups repeats within window', async () => {
  const sent: string[] = []
  const svc = new AlertService({ now, dedupeMs: 60000, channels: [{ name: 'all', send: async (g) => { sent.push(g.title); return 'ok' } }] })
  await svc.fire({ fingerprint: 'x:1', title: 'alert', severity: 'warning', source: 't', at: T })
  await svc.fire({ fingerprint: 'x:1', title: 'alert', severity: 'warning', source: 't', at: T + 1000 })
  if (sent.length !== 1) throw new Error(`should dedupe, sent ${sent.length}`)
})
test('alert: silence suppresses matching alerts', async () => {
  const sent: string[] = []
  const svc = new AlertService({ now, channels: [{ name: 'all', send: async (g) => { sent.push(g.title); return 'ok' } }] })
  svc.silence('web-01', T + 60000)
  const r = await svc.fire({ fingerprint: 'watchdog:web-01:down', title: 'down', severity: 'critical', source: 't', at: T })
  if (r.sent) throw new Error('silenced alert should not send')
  if (sent.length !== 0) throw new Error('should not route silenced')
})
test('alert: group count accumulates', async () => {
  const svc = new AlertService({ now, dedupeMs: 60000, channels: [] })
  await svc.fire({ fingerprint: 'x', title: 't', severity: 'info', source: 's', at: T })
  const r = await svc.fire({ fingerprint: 'x', title: 't', severity: 'info', source: 's', at: T + 1000 })
  if (r.group.count !== 2) throw new Error(`count ${r.group.count}`)
})

// ---- IncidentLedger ----
test('incident: create new incident with detected event', () => {
  const il = new IncidentLedger({ now })
  const { incident, isNew } = il.create({ title: 'web-01 down', source: 'watchdog', affected: ['web-01'] })
  if (!isNew) throw new Error('should be new')
  if (incident.status !== 'open') throw new Error('should be open')
  if (incident.timeline.length !== 1) throw new Error('should have detected event')
})
test('incident: repeat create for same title+source returns existing', () => {
  const il = new IncidentLedger({ now })
  const a = il.create({ title: 'down', source: 'watchdog' })
  const b = il.create({ title: 'down', source: 'watchdog' })
  if (b.isNew) throw new Error('should not be new')
  if (a.incident.id !== b.incident.id) throw new Error('should dedupe')
})
test('incident: mitigate/resolve transitions status + timestamps', () => {
  const il = new IncidentLedger({ now })
  const { incident } = il.create({ title: 'down', source: 'watchdog' })
  if (!il.mitigate(incident.id)) throw new Error('mitigate failed')
  if (il.get(incident.id)!.status !== 'mitigated') throw new Error('not mitigated')
  if (!il.resolve(incident.id)) throw new Error('resolve failed')
  if (il.get(incident.id)!.status !== 'resolved') throw new Error('not resolved')
})
test('incident: setRca + postmortem includes rca + timeline', () => {
  const il = new IncidentLedger({ now })
  const { incident } = il.create({ title: 'db down', source: 'watchdog' })
  il.setRca(incident.id, 'disk full caused db crash')
  il.linkRunbook(incident.id, 'pb-db-recovery')
  il.resolve(incident.id)
  const pm = il.postmortem(incident.id)!
  if (!pm.includes('disk full caused db crash')) throw new Error('pm missing rca')
  if (!pm.includes('pb-db-recovery')) throw new Error('pm missing runbook')
  if (!pm.includes('Timeline')) throw new Error('pm missing timeline')
})

// ---- GoldenSignals ----
test('golden: report maps saturation + traffic from ledger', () => {
  const l = new MetricsLedger({ now })
  l.record('h', snap(T, 55, 65, 75))
  const gs = new GoldenSignals({ ledger: l, now })
  const r = gs.report('h')
  if (r.cpuPercent !== 55 || r.memPercent !== 65 || r.diskPercentMax !== 75) throw new Error('saturation')
  if (r.netRxBps !== 1000) throw new Error('traffic')
})
test('golden: latency percentiles from synthetic series', () => {
  const l = new MetricsLedger({ now })
  l.record('h', snap(T))
  const gs = new GoldenSignals({ ledger: l, now, latencyFor: () => [10, 20, 30, 40, 50, 100].map((ms, i) => ({ at: T + i, ms })) })
  const r = gs.report('h')
  if (r.latencyP50Ms === undefined || r.latencyP95Ms === undefined) throw new Error('latency percentiles missing')
})
test('golden: capacityForecast returns daysToFull per host', () => {
  const l = new MetricsLedger({ now })
  for (let d = 0; d < 10; d += 1) l.record('h', snap(T + d * day, 50, 50, 40 + d * 2))
  const gs = new GoldenSignals({ ledger: l, now })
  const f = gs.capacityForecast()
  if (f.length !== 1 || f[0].daysToFull === undefined) throw new Error('forecast')
})

// ---- SyntheticChecks ----
test('synthetic: run records latency + ok and feeds sliCounts', async () => {
  const sc = new SyntheticChecks({ probeHttp: async () => 200, now })
  sc.add({ id: 'c1', name: 'api', kind: 'http', address: 'https://api/health', host: 'h1' })
  await sc.run('c1')
  const { good, total } = sc.sliCounts('h1', 0)
  if (total !== 1 || good !== 1) throw new Error(`sli ${good}/${total}`)
})
test('synthetic: errorRate reflects failures', async () => {
  let ok = true
  const sc = new SyntheticChecks({ probeHttp: async () => (ok ? 200 : 500), now })
  sc.add({ id: 'c1', name: 'api', kind: 'http', address: 'https://api', host: 'h1' })
  await sc.run('c1')
  ok = false
  await sc.run('c1')
  const er = sc.errorRate('h1', 0)
  if (Math.abs((er ?? 0) - 0.5) > 1e-9) throw new Error(`errorRate ${er}`)
})
test('synthetic: latencySeries returns ordered samples', async () => {
  const sc = new SyntheticChecks({ probeTcp: async () => true, now })
  sc.add({ id: 'c1', name: 'ssh', kind: 'tcp', address: 'h', expect: 22, host: 'h1' })
  await sc.run('c1'); await sc.run('c1')
  const s = sc.latencySeries('h1', 0)
  if (s.length !== 2) throw new Error(`series ${s.length}`)
})

// ---- DriftDetector ----
test('drift: diffConfigs finds added + removed lines', () => {
  const { added, removed } = diffConfigs(['a', 'b', 'c'], ['a', 'c', 'd'])
  if (removed.length !== 1 || removed[0].line !== 'b') throw new Error('removed')
  if (added.length !== 1 || added[0].line !== 'd') throw new Error('added')
})
test('drift: no drift when configs match', async () => {
  const d = new DriftDetector({ render: async () => 'line1\nline2', getActual: async () => 'line1\nline2', now })
  const t = d.upsert({ name: 'rtr', templateId: 't1', host: 'rtr-1' })
  const r = await d.check(t.id)
  if (r.drifted) throw new Error('should not be drifted')
})
test('drift: drifted when device differs, fires onDrift + proposeChange', async () => {
  const events: string[] = []
  const d = new DriftDetector({
    render: async () => 'hostname rtr1\nntp server 1.1.1.1',
    getActual: async () => 'hostname rtr1',
    now,
    onDrift: () => events.push('drift'),
    proposeChange: async () => { events.push('change'); return 'chg' },
  })
  const t = d.upsert({ name: 'rtr', templateId: 't1', host: 'rtr-1' })
  const r = await d.check(t.id)
  if (!r.drifted) throw new Error('should be drifted')
  if (r.removed.length !== 1) throw new Error('should have 1 removed')
  if (!events.includes('drift') || !events.includes('change')) throw new Error(`events ${events}`)
})
test('drift: ignorePatterns exclude matching lines', async () => {
  const d = new DriftDetector({ render: async () => 'version 1.0\nconfig a', getActual: async () => 'version 2.0\nconfig a', now })
  const t = d.upsert({ name: 'x', templateId: 't', host: 'x', ignorePatterns: ['^version'] })
  const r = await d.check(t.id)
  if (r.drifted) throw new Error('ignore should suppress drift')
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
