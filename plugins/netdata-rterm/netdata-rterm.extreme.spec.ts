import {
  parseNetdataAlert, mapSeverity, buildFingerprint, toTriggerEvent, correlateWithRterm, register,
} from './index.mjs'

const cases: Array<{ name: string; run: () => void | Promise<void> }> = []
function test(n: string, r: () => void | Promise<void>) { cases.push({ name: n, run: r }) }

// ---- parseNetdataAlert ----
test('parse: alert notification with all fields', () => {
  const payload = {
    message: 'CPU usage is 95%', alert: 'cpu_usage', info: 'CPU utilization too high',
    chart: 'system.cpu', context: 'system.cpu', space: 'prod-cluster', family: 'cpu',
    class: 'Error', severity: 'critical', date: '2026-07-22T10:00:00Z', duration: '5m',
    additional_active_critical_alerts: 2, additional_active_warning_alerts: 1,
    alert_url: 'https://app.netdata.cloud/alert/123',
  }
  const p = parseNetdataAlert(payload)
  if (!p || p.kind !== 'alert') throw new Error('should parse alert')
  if (p.alert !== 'cpu_usage') throw new Error('alert name')
  if (p.severity !== 'critical') throw new Error('severity')
  if (p.chart !== 'system.cpu') throw new Error('chart')
  if (p.additionalCritical !== 2) throw new Error('additional critical')
  if (p.host !== 'prod-cluster') throw new Error('host from space')
  if (p.alertUrl !== 'https://app.netdata.cloud/alert/123') throw new Error('alert url')
})

test('parse: warning severity', () => {
  const p = parseNetdataAlert({ alert: 'disk_space', severity: 'warning', message: 'Disk 80% full', space: 'web-01' })
  if (!p || p.severity !== 'warning') throw new Error('should be warning')
})

test('parse: clear severity (alert resolved)', () => {
  const p = parseNetdataAlert({ alert: 'cpu_usage', severity: 'clear', message: 'CPU back to normal', space: 'web-01' })
  if (!p || p.severity !== 'clear') throw new Error('should be clear')
})

test('parse: reachability notification (node down)', () => {
  const p = parseNetdataAlert({ message: 'Node unreachable', node: 'web-02', space: 'prod', status: 'down', date: '2026-07-22T10:00:00Z', duration: '2m' })
  if (!p || p.kind !== 'reachability') throw new Error('should parse reachability')
  if (p.status !== 'down') throw new Error('status')
  if (p.host !== 'web-02') throw new Error('host from node')
})

test('parse: reachability notification (node up)', () => {
  const p = parseNetdataAlert({ node: 'web-02', status: 'up', date: '2026-07-22T10:05:00Z' })
  if (!p || p.status !== 'up') throw new Error('should be up')
})

test('parse: null for invalid payload', () => {
  if (parseNetdataAlert(null) !== null) throw new Error('null payload')
  if (parseNetdataAlert({}) !== null) throw new Error('empty object')
  if (parseNetdataAlert('not an object') !== null) throw new Error('string')
  if (parseNetdataAlert({ foo: 'bar' }) !== null) throw new Error('missing required fields')
})

// ---- mapSeverity ----
test('mapSeverity: critical -> critical', () => {
  if (mapSeverity('critical') !== 'critical') throw new Error('critical')
})
test('mapSeverity: warning -> warning', () => {
  if (mapSeverity('warning') !== 'warning') throw new Error('warning')
})
test('mapSeverity: clear -> info', () => {
  if (mapSeverity('clear') !== 'info') throw new Error('clear should map to info')
})
test('mapSeverity: unknown -> info', () => {
  if (mapSeverity('unknown') !== 'info') throw new Error('unknown')
})

// ---- buildFingerprint ----
test('buildFingerprint: alert fingerprint', () => {
  const p = parseNetdataAlert({ alert: 'cpu_usage', severity: 'critical', space: 'web-01' })
  const fp = buildFingerprint(p)
  if (fp !== 'netdata:web-01:cpu_usage:critical') throw new Error(`got ${fp}`)
})
test('buildFingerprint: reachability fingerprint', () => {
  const p = parseNetdataAlert({ node: 'web-02', status: 'down' })
  const fp = buildFingerprint(p)
  if (fp !== 'netdata:reachability:web-02:down') throw new Error(`got ${fp}`)
})
test('buildFingerprint: empty for null', () => {
  if (buildFingerprint(null) !== '') throw new Error('should be empty')
})

// ---- toTriggerEvent ----
test('toTriggerEvent: alert -> trigger event with correct severity', () => {
  const p = parseNetdataAlert({ alert: 'disk_full', severity: 'critical', space: 'db-01', message: 'Disk 95%', date: '2026-07-22T10:00:00Z' })
  const evt = toTriggerEvent(p)
  if (!evt) throw new Error('should produce event')
  if (evt.source !== 'netdata') throw new Error('source')
  if (evt.severity !== 'critical') throw new Error('severity')
  if (!evt.title.includes('disk_full')) throw new Error('title')
  if (!evt.title.includes('db-01')) throw new Error('title host')
  if (evt.labels.host !== 'db-01') throw new Error('labels host')
  if (evt.labels.alert !== 'disk_full') throw new Error('labels alert')
})

test('toTriggerEvent: reachability down -> critical', () => {
  const p = parseNetdataAlert({ node: 'web-03', status: 'down', date: '2026-07-22T10:00:00Z' })
  const evt = toTriggerEvent(p)
  if (!evt || evt.severity !== 'critical') throw new Error('down should be critical')
  if (!evt.title.includes('DOWN')) throw new Error('title')
})

test('toTriggerEvent: reachability up -> info', () => {
  const p = parseNetdataAlert({ node: 'web-03', status: 'up', date: '2026-07-22T10:00:00Z' })
  const evt = toTriggerEvent(p)
  if (!evt || evt.severity !== 'info') throw new Error('up should be info')
})

test('toTriggerEvent: null parsed -> null event', () => {
  if (toTriggerEvent(null) !== null) throw new Error('should be null')
})

// ---- correlateWithRterm ----
test('correlate: with metrics + incidents', () => {
  const p = parseNetdataAlert({ alert: 'cpu_usage', severity: 'critical', space: 'web-01', additional_active_critical_alerts: 3 })
  const mockMetrics = { snapshot: (host: string) => ({ host, cpuUsagePercent: 95, memoryUsagePercent: 70 }) }
  const mockIncidents = { list: () => [
    { title: 'web-01 disk full', affected: ['web-01'], status: 'open' },
    { title: 'web-02 network issue', affected: ['web-02'], status: 'open' },
    { title: 'web-01 resolved issue', affected: ['web-01'], status: 'resolved' },
  ] }
  const result = correlateWithRterm(p, mockMetrics as any, mockIncidents as any)
  if (!result.recentMetrics || result.recentMetrics.cpuUsagePercent !== 95) throw new Error('metrics')
  if (result.openIncidents.length !== 1) throw new Error(`expected 1 open incident, got ${result.openIncidents.length}`)
  if (!result.correlation.includes('cpu_usage')) throw new Error('correlation should mention alert')
  if (!result.correlation.includes('disk full')) throw new Error('correlation should mention incident')
  if (!result.correlation.includes('3 additional critical')) throw new Error('correlation should mention additional alerts')
})

test('correlate: no prior context', () => {
  const p = parseNetdataAlert({ alert: 'mem_usage', severity: 'warning', space: 'new-host' })
  const result = correlateWithRterm(p, null, null)
  if (result.recentMetrics !== null) throw new Error('no metrics')
  if (result.openIncidents.length !== 0) throw new Error('no incidents')
  if (!result.correlation.includes('No prior RTerm context')) throw new Error('should say no context')
})

test('correlate: null parsed -> empty', () => {
  const result = correlateWithRterm(null, null, null)
  if (result.recentMetrics !== null || result.openIncidents.length !== 0) throw new Error('should be empty')
})

// ---- register (plugin lifecycle) ----
test('register: registers 2 tools, 2 triggers, 1 panel', () => {
  const tools: any[] = [], triggers: any[] = [], panels: any[] = [], logs: string[] = []
  register({
    registerTool: (t) => tools.push(t),
    registerTrigger: (t) => triggers.push(t),
    registerPanel: (p) => panels.push(p),
    exec: async () => '',
    readLedger: () => ({}),
    log: (line: string) => logs.push(line),
  } as any)
  if (tools.length !== 2) throw new Error(`expected 2 tools, got ${tools.length}`)
  if (triggers.length !== 2) throw new Error(`expected 2 triggers, got ${triggers.length}`)
  if (panels.length !== 1) throw new Error(`expected 1 panel, got ${panels.length}`)
  if (!tools.some((t) => t.name === 'netdata_alert_summary')) throw new Error('missing alert_summary tool')
  if (!tools.some((t) => t.name === 'netdata_correlate')) throw new Error('missing correlate tool')
  if (!triggers.some((t) => t.name === 'netdata_critical_alert')) throw new Error('missing critical trigger')
  if (!triggers.some((t) => t.name === 'netdata_warning_alert')) throw new Error('missing warning trigger')
  if (!panels.some((p) => p.name === 'netdata-alert-feed')) throw new Error('missing alert feed panel')
  if (!logs.some((l) => l.includes('registered'))) throw new Error('should log registration')
})

test('register: critical trigger matches critical events only', () => {
  const triggers: any[] = []
  register({
    registerTool: () => {}, registerTrigger: (t) => triggers.push(t), registerPanel: () => {},
    exec: async () => '', readLedger: () => ({}), log: () => {},
  } as any)
  const critTrigger = triggers.find((t) => t.name === 'netdata_critical_alert')
  if (!critTrigger) throw new Error('missing critical trigger')
  if (!critTrigger.match({ source: 'netdata', severity: 'critical' })) throw new Error('should match critical')
  if (critTrigger.match({ source: 'netdata', severity: 'warning' })) throw new Error('should NOT match warning')
  if (critTrigger.match({ source: 'other', severity: 'critical' })) throw new Error('should NOT match non-netdata')
  if (critTrigger.match({})) throw new Error('should NOT match empty')
})

test('register: warning trigger matches warning events only', () => {
  const triggers: any[] = []
  register({
    registerTool: () => {}, registerTrigger: (t) => triggers.push(t), registerPanel: () => {},
    exec: async () => '', readLedger: () => ({}), log: () => {},
  } as any)
  const warnTrigger = triggers.find((t) => t.name === 'netdata_warning_alert')
  if (!warnTrigger) throw new Error('missing warning trigger')
  if (!warnTrigger.match({ source: 'netdata', severity: 'warning' })) throw new Error('should match warning')
  if (warnTrigger.match({ source: 'netdata', severity: 'critical' })) throw new Error('should NOT match critical')
})

test('register: panel renders alert rows', () => {
  const panels: any[] = []
  register({
    registerTool: () => {}, registerTrigger: () => {}, registerPanel: (p) => panels.push(p),
    exec: async () => '', readLedger: () => ({}), log: () => {},
  } as any)
  const panel = panels[0]
  const html = panel.render([
    { host: 'web-01', alert: 'cpu_high', severity: 'critical', date: '2026-07-22' },
    { host: 'web-02', alert: 'disk_full', severity: 'warning', date: '2026-07-22' },
  ])
  if (!html.includes('cpu_high') || !html.includes('disk_full')) throw new Error('should contain alert names')
  if (!html.includes('<table>')) throw new Error('should render table')
})

test('register: panel renders empty feed', () => {
  const panels: any[] = []
  register({
    registerTool: () => {}, registerTrigger: () => {}, registerPanel: (p) => panels.push(p),
    exec: async () => '', readLedger: () => ({}), log: () => {},
  } as any)
  const html = panels[0].render(null)
  if (!html.includes('Netdata Alerts')) throw new Error('should have title even when empty')
})

test('register: netdata_correlate tool handles invalid payload', async () => {
  const tools: any[] = []
  register({
    registerTool: (t) => tools.push(t), registerTrigger: () => {}, registerPanel: () => {},
    exec: async () => '', readLedger: () => ({}), log: () => {},
  } as any)
  const correlateTool = tools.find((t) => t.name === 'netdata_correlate')
  const result = await correlateTool.handler({ alert: { foo: 'bar' } })
  if (!result.error) throw new Error('should return error for invalid payload')
})

test('register: netdata_correlate tool correlates valid payload', async () => {
  const tools: any[] = []
  register({
    registerTool: (t) => tools.push(t), registerTrigger: () => {}, registerPanel: () => {},
    exec: async () => '', readLedger: () => null, log: () => {},
  } as any)
  const correlateTool = tools.find((t) => t.name === 'netdata_correlate')
  const result = await correlateTool.handler({
    alert: { alert: 'cpu_usage', severity: 'critical', space: 'web-01', message: 'CPU 95%' },
  })
  if (!result.parsed) throw new Error('should return parsed alert')
  if (result.parsed.alert !== 'cpu_usage') throw new Error('alert name')
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
