import {
  buildSlackPayload, slackChannel, buildTeamsPayload, teamsChannel,
  buildEmail, smtpChannel, buildTelegramPayload, telegramChannel,
} from '../notify/notifyService'
import { DashboardService } from '../dashboard/dashboardService'
import { MetricsLedger } from '../sre/metricsLedger'
import { GoldenSignals } from '../sre/goldenSignals'
import { SloService } from '../sre/sloService'
import { UptimeWatchdog } from '../sre/uptimeWatchdog'
import { IncidentLedger } from '../sre/incidentLedger'
import { SpanLedger } from '../apm/spanLedger'
import { RumLedger } from '../dem/rumLedger'
import { InfraMonitor } from '../infra/infraMonitor'
import type { AlertGroup, AlertSeverity } from '../sre/alertService'
import type { ResourceSnapshot } from '../../types'

const cases: Array<{ name: string; run: () => void | Promise<void> }> = []
function test(n: string, r: () => void | Promise<void>) { cases.push({ name: n, run: r }) }
let T = 1_000_000
const now = () => T

function group(sev: AlertSeverity, title = 'test alert', over: Partial<AlertGroup> = {}): AlertGroup {
  return {
    fingerprint: 'watchdog:web-01:down',
    title,
    severity: sev,
    count: 2,
    firstAt: T - 5000,
    lastAt: T,
    lastAlert: { fingerprint: 'watchdog:web-01:down', title, severity: sev, source: 'watchdog', detail: 'host web-01 is down', labels: { host: 'web-01' }, at: T },
    silenced: false,
    ...over,
  }
}

function fakeFetch(captured: Array<{ url: string; body: string }>, ok = true) {
  return async (url: string, init: { body: string }) => {
    captured.push({ url, body: init.body })
    return { ok, status: ok ? 200 : 500, text: async () => 'resp' }
  }
}

function snap(at: number, cpu = 50): ResourceSnapshot {
  return {
    timestamp: at, terminalId: 'h',
    cpu: { usagePercent: cpu },
    memory: { totalBytes: 1e9, usedBytes: 5e8, availableBytes: 5e8, usagePercent: 50 },
    disks: [{ filesystem: 'fs', mountPoint: '/', totalBytes: 1e9, usedBytes: 5e8, availableBytes: 5e8, usagePercent: cpu }],
    network: [{ interface: 'eth0', rxBytesPerSec: 100, txBytesPerSec: 200 }],
    uptimeSeconds: 100,
  } as unknown as ResourceSnapshot
}

function mkDashboard() {
  const metricsLedger = new MetricsLedger({ now })
  metricsLedger.record('web-01', snap(T, 80))
  metricsLedger.record('db-01', snap(T, 40))
  const goldenSignals = new GoldenSignals({ ledger: metricsLedger, now })
  const sloService = new SloService({ source: { count: async () => ({ good: 900, total: 1000 }) }, now })
  sloService.upsert({ name: 'api', target: 0.999, windowMs: 86400000 })
  const uptimeWatchdog = new UptimeWatchdog({ probeTcp: async () => true, now })
  const wt = uptimeWatchdog.upsert({ name: 'web-01', kind: 'tcp', address: 'web-01', expect: 443 })
  uptimeWatchdog.allStatus().forEach(() => {})
  const incidentLedger = new IncidentLedger({ now })
  incidentLedger.create({ title: 'web-01 down', source: 'watchdog', affected: ['web-01'] })
  const spanLedger = new SpanLedger({ now })
  spanLedger.ingest({ traceId: 't1', spanId: 's1', service: 'api', name: 'op', startMs: T, durationMs: 300, status: 'error' })
  const rumLedger = new RumLedger({ now })
  for (let i = 0; i < 5; i += 1) rumLedger.ingest({ page: '/checkout', lcpMs: 3000 })
  const infraMonitor = new InfraMonitor({ now })
  infraMonitor.recordCluster('prod', [{ name: 'a', namespace: 'd', phase: 'Running', restarts: 0, ready: true }], [{ name: 'n1', ready: true }])
  const svc = new DashboardService({ metricsLedger, goldenSignals, sloService, uptimeWatchdog, incidentLedger, spanLedger, rumLedger, infraMonitor, now })
  return { svc, wt }
}

// ---- Slack ----
test('slack: payload has severity color + emoji + facts + fingerprint', () => {
  const p = buildSlackPayload(group('critical')) as { attachments: Array<Record<string, unknown>> }
  const att = p.attachments[0]
  if (att.color !== '#c92a2a') throw new Error(`color ${att.color}`)
  if (!String(att.title).includes('🔥')) throw new Error('emoji')
  if (!Array.isArray(att.fields)) throw new Error('fields')
  if (!String(att.footer).includes('watchdog:web-01:down')) throw new Error('fingerprint')
})
test('slack: critical uses red, info uses teal', () => {
  const crit = buildSlackPayload(group('critical')) as { attachments: Array<{ color: string }> }
  const info = buildSlackPayload(group('info')) as { attachments: Array<{ color: string }> }
  if (crit.attachments[0].color !== '#c92a2a') throw new Error('crit color')
  if (info.attachments[0].color !== '#0b7285') throw new Error('info color')
})
test('slack: channel posts JSON to the webhook url', async () => {
  const captured: Array<{ url: string; body: string }> = []
  const ch = slackChannel({ webhookUrl: 'https://hooks.slack.com/services/X' }, fakeFetch(captured))
  await ch.send(group('warning'))
  if (captured.length !== 1) throw new Error('no post')
  if (captured[0].url !== 'https://hooks.slack.com/services/X') throw new Error('url')
  if (!captured[0].body.includes('attachments')) throw new Error('body')
})
test('slack: channel throws on non-ok response', async () => {
  const ch = slackChannel({ webhookUrl: 'https://x' }, fakeFetch([], false))
  let threw = false
  try { await ch.send(group('info')) } catch { threw = true }
  if (!threw) throw new Error('should throw on 500')
})
test('slack: honors minSeverity on the channel', () => {
  const ch = slackChannel({ webhookUrl: 'https://x', minSeverity: 'critical' }, fakeFetch([]))
  if (ch.minSeverity !== 'critical') throw new Error('minSeverity')
})

// ---- Teams ----
test('teams: payload is MessageCard with themeColor + facts', () => {
  const p = buildTeamsPayload(group('warning')) as Record<string, unknown>
  if (p['@type'] !== 'MessageCard') throw new Error('type')
  if (p.themeColor !== 'b45309') throw new Error(`themeColor ${p.themeColor}`)
  const sections = p.sections as Array<{ facts: unknown[] }>
  if (!Array.isArray(sections[0].facts)) throw new Error('facts')
})
test('teams: channel posts to the webhook url', async () => {
  const captured: Array<{ url: string; body: string }> = []
  const ch = teamsChannel({ webhookUrl: 'https://outlook.office.com/webhook/X' }, fakeFetch(captured))
  await ch.send(group('critical'))
  if (captured.length !== 1 || !captured[0].body.includes('MessageCard')) throw new Error('teams post')
})

// ---- Email / SMTP ----
test('email: builds subject with severity + HTML with color bar + text', () => {
  const m = buildEmail(group('critical'), 'rterm@ops.example', ['oncall@ops.example'])
  if (!m.subject.includes('[CRITICAL]')) throw new Error('subject')
  if (!m.html.includes('#c92a2a')) throw new Error('html color')
  if (!m.html.includes('border-left')) throw new Error('html structure')
  if (!m.text.includes('Severity: CRITICAL')) throw new Error('text')
  if (m.from !== 'rterm@ops.example' || m.to[0] !== 'oncall@ops.example') throw new Error('from/to')
})
test('email: escapes HTML in detail', () => {
  const g = group('warning', 'x <script>alert(1)</script>')
  const m = buildEmail(g, 'a@b.c', ['d@e.f'])
  if (m.html.includes('<script>alert')) throw new Error('should escape script')
})
test('email: channel calls the smtp sender with the mail', async () => {
  const sent: Array<{ subject: string }> = []
  const ch = smtpChannel({ from: 'a@b.c', to: ['d@e.f'] }, async (mail) => { sent.push(mail); return 'queued' })
  const r = await ch.send(group('info'))
  if (r !== 'queued') throw new Error('result')
  if (sent.length !== 1 || !sent[0].subject.includes('[INFO]')) throw new Error('smtp send')
})

// ---- Telegram ----
test('telegram: payload has chat_id + markdown text with severity', () => {
  const p = buildTelegramPayload('12345', group('critical')) as Record<string, unknown>
  if (p.chat_id !== '12345') throw new Error('chat_id')
  if (!String(p.text).includes('CRITICAL') || !String(p.text).includes('🔥')) throw new Error('text')
  if (p.parse_mode !== 'Markdown') throw new Error('parse_mode')
})
test('telegram: channel posts to the bot API url', async () => {
  const captured: Array<{ url: string; body: string }> = []
  const ch = telegramChannel({ botToken: 'TOK', chatId: '123' }, fakeFetch(captured))
  await ch.send(group('warning'))
  if (!captured[0].url.includes('botTOK/sendMessage')) throw new Error('url')
})

// ---- DashboardService ----
test('dashboard: state composes hosts + uptime + slos + incidents + apm + dem + clusters + capacity', async () => {
  const { svc } = mkDashboard()
  const s = await svc.state()
  if (s.hosts.length !== 2) throw new Error(`hosts ${s.hosts.length}`)
  if (s.slos.length !== 1) throw new Error('slos')
  if (s.incidents.length !== 1) throw new Error('incidents')
  if (s.apm.bottleneckServices.length !== 1) throw new Error('apm')
  if (s.dem.slowestPages.length !== 1) throw new Error('dem')
  if (s.clusters.length !== 1) throw new Error('clusters')
  if (!Array.isArray(s.capacity)) throw new Error('capacity')
})
test('dashboard: hosts merge golden + uptime by host', async () => {
  const { svc } = mkDashboard()
  const s = await svc.state()
  const web = s.hosts.find((h) => h.host === 'web-01')!
  if (!web.golden) throw new Error('web should have golden')
  if (web.golden.cpuPercent !== 80) throw new Error('golden cpu')
})
test('dashboard: summary reports host/down/degraded/incidents/fastburn counts', async () => {
  const { svc } = mkDashboard()
  const sum = await svc.summary()
  if (!sum.includes('2 hosts')) throw new Error(`summary hosts: ${sum}`)
  if (!sum.includes('open incident')) throw new Error(`summary incidents: ${sum}`)
  if (!sum.includes('SLO')) throw new Error(`summary slo: ${sum}`)
})
test('dashboard: works with optional ledgers absent (apm/dem/k8s empty)', async () => {
  const metricsLedger = new MetricsLedger({ now })
  metricsLedger.record('h', snap(T, 50))
  const svc = new DashboardService({
    metricsLedger,
    goldenSignals: new GoldenSignals({ ledger: metricsLedger, now }),
    sloService: new SloService({ source: { count: async () => ({ good: 1, total: 1 }) }, now }),
    uptimeWatchdog: new UptimeWatchdog({ now }),
    incidentLedger: new IncidentLedger({ now }),
    now,
  })
  const s = await svc.state()
  if (s.apm.bottleneckServices.length !== 0 || s.dem.slowestPages.length !== 0 || s.clusters.length !== 0) {
    throw new Error('optional ledgers should be empty')
  }
})
test('dashboard: section limit caps incidents', async () => {
  const metricsLedger = new MetricsLedger({ now })
  const incidentLedger = new IncidentLedger({ now })
  for (let i = 0; i < 15; i += 1) incidentLedger.create({ title: `inc-${i}`, source: 'x' })
  const svc = new DashboardService({
    metricsLedger,
    goldenSignals: new GoldenSignals({ ledger: metricsLedger, now }),
    sloService: new SloService({ source: { count: async () => ({ good: 1, total: 1 }) }, now }),
    uptimeWatchdog: new UptimeWatchdog({ now }),
    incidentLedger,
    now,
    sectionLimit: 5,
  })
  const s = await svc.state()
  if (s.incidents.length !== 5) throw new Error(`limit ${s.incidents.length}`)
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
