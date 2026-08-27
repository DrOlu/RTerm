import {
  collectWork,
  dashboardEmptyHints,
  emptyHint,
  filterHostsByQuery,
  matchConnectionForHost,
  presentDashboard,
  rankSituation,
  situationHeadline,
} from './dashboardPresentation'

const assert = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(`assert failed: ${msg}`)
}
const runCase = async (name: string, fn: () => void): Promise<void> => {
  fn()
  console.log(`PASS ${name}`)
}

await runCase('emptyHint: null when rows exist, object when empty', () => {
  assert(emptyHint('hosts', true, 'x') === null, 'has rows')
  const h = emptyHint('hosts', false, 'open a terminal')
  assert(h?.section === 'hosts' && h.message.includes('terminal'), String(h?.message))
})

await runCase('empty fleet → all-clear situation + host empty hint', () => {
  const p = presentDashboard({ hosts: [], slos: [], uptime: [], incidents: [], apm: {}, dem: {}, clusters: [], capacity: [] })
  assert(p.situation.length === 1 && p.situation[0].kind === 'all-clear', JSON.stringify(p.situation))
  assert(p.headline.toLowerCase().includes('all clear'), p.headline)
  assert(p.empty.some((e) => e.section === 'hosts'), 'hosts empty hint')
  assert(p.empty.some((e) => e.section === 'apm'), 'apm empty hint')
  assert(p.downCount === 0 && p.hostCount === 0, 'counts')
})

await runCase('host down ranks critical above degraded and all-clear is gone', () => {
  const items = rankSituation({
    uptime: [
      { target: { name: 'web-1' }, state: 'degraded', lastError: 'slow' },
      { target: { name: 'db-1' }, state: 'down', lastError: 'timeout', consecutiveFailures: 3 },
    ],
  })
  assert(items[0].kind === 'host-down' && items[0].severity === 'critical', items[0].kind)
  assert(items[0].action?.type === 'open-host' && items[0].action?.target === 'db-1', JSON.stringify(items[0].action))
  assert(items.some((i) => i.kind === 'host-degraded'), 'degraded present')
  assert(!items.some((i) => i.kind === 'all-clear'), 'no all-clear')
})

await runCase('uptime entries without a name are skipped (no crash)', () => {
  const items = rankSituation({ uptime: [{ state: 'down' }, { target: {}, state: 'down' }] })
  assert(items.length === 1 && items[0].kind === 'all-clear', JSON.stringify(items))
})

await runCase('sev1/sev2 incidents are critical; sev3 is warning', () => {
  const items = rankSituation({
    incidents: [
      { id: 'i1', title: 'pager', severity: 'sev1', affected: ['web-1'] },
      { id: 'i2', title: 'noise', severity: 'sev3', affected: [] },
    ],
  })
  const sev1 = items.find((i) => i.id === 'inc:i1')
  const sev3 = items.find((i) => i.id === 'inc:i2')
  assert(sev1?.severity === 'critical', String(sev1?.severity))
  assert(sev3?.severity === 'warning', String(sev3?.severity))
  assert(sev1?.action?.type === 'open-chat', 'incident asks agent')
})

await runCase('healthy SLO is ignored; fast-burning is critical', () => {
  const items = rankSituation({
    slos: [
      { sloId: 'ok', fastBurning: false, burnRate: 0.1 },
      { sloId: 'api', fastBurning: true, burnRate: 14.2, errorBudgetRemaining: 0.05 },
    ],
  })
  assert(items.some((i) => i.kind === 'slo-burn' && i.title.includes('api')), JSON.stringify(items))
  assert(!items.some((i) => i.title.includes('ok')), 'healthy omitted')
})

await runCase('disk <2d is critical; <7d warning; >=7d omitted', () => {
  const items = rankSituation({
    capacity: [
      { host: 'a', daysToFull: 1.2, diskPercent: 98 },
      { host: 'b', daysToFull: 5, diskPercent: 80 },
      { host: 'c', daysToFull: 40, diskPercent: 50 },
    ],
  })
  const a = items.find((i) => i.id === 'disk:a')
  const b = items.find((i) => i.id === 'disk:b')
  assert(a?.severity === 'critical', String(a?.severity))
  assert(b?.severity === 'warning', String(b?.severity))
  assert(!items.some((i) => i.id === 'disk:c'), '40d omitted')
})

await runCase('crashloop cluster is critical; not-ready-only is warning', () => {
  const items = rankSituation({
    clusters: [
      { context: 'prod', crashLoopPods: 2, notReadyPods: 1, totalPods: 10 },
      { context: 'stage', crashLoopPods: 0, notReadyPods: 3, totalPods: 4 },
      { context: 'ok', crashLoopPods: 0, notReadyPods: 0, totalPods: 8 },
    ],
  })
  assert(items.find((i) => i.id === 'k8s:prod')?.severity === 'critical', 'prod')
  assert(items.find((i) => i.id === 'k8s:stage')?.severity === 'warning', 'stage')
  assert(!items.some((i) => i.id === 'k8s:ok'), 'healthy cluster omitted')
})

await runCase('failed playbook + failed agent run appear as work and situation', () => {
  const extras = {
    playbooks: [{ id: 'pb1', name: 'bounce-nginx', lastRunAt: '2026-08-27T00:00:00Z', lastRunOk: false }],
    agentRuns: [
      { runId: 'r1', sessionId: 's1', status: 'failed', error: 'boom', startedAt: 2, inputPreview: 'fix bgp' },
      { runId: 'r0', sessionId: 's0', status: 'completed', startedAt: 1 },
    ],
  }
  const p = presentDashboard({}, extras)
  assert(p.situation.some((i) => i.kind === 'playbook-failed'), 'pb situation')
  assert(p.situation.some((i) => i.kind === 'agent-failed'), 'run situation')
  assert(p.work.playbooks[0].ok === false, 'work pb failed')
  assert(p.work.agentRuns[0].id === 'r1', 'newest run first')
  assert(p.work.playbooks[0].action?.target === 'playbooks', 'opens playbooks')
})

await runCase('collectWork drops playbooks/tasks with no lastRunAt', () => {
  const w = collectWork({
    playbooks: [{ id: 'x', name: 'never-ran' }],
    scheduledTasks: [{ id: 't', name: 'cron', lastRunAt: '2026-01-01', enabled: false }],
    triggers: [{ id: 'g', name: 'bgp', kind: 'pattern', fireCount: 2, lastFiredAt: 9 }],
  })
  assert(w.playbooks.length === 0, 'unrun playbook omitted')
  assert(w.scheduledTasks[0].detail === 'disabled', w.scheduledTasks[0].detail)
  assert(w.triggers[0].name === 'bgp', 'trigger kept')
})

await runCase('work lists cap at 8 and sort newest first', () => {
  const extras = {
    playbooks: Array.from({ length: 12 }, (_, i) => ({
      id: `p${i}`,
      name: `p${i}`,
      lastRunAt: `2026-08-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
      lastRunOk: true,
    })),
  }
  const w = collectWork(extras)
  assert(w.playbooks.length === 8, String(w.playbooks.length))
  assert(w.playbooks[0].id === 'p11', `first=${w.playbooks[0].id}`)
})

await runCase('situation caps at 8; criticals fill first', () => {
  const items = rankSituation({
    uptime: Array.from({ length: 12 }, (_, i) => ({
      target: { name: `h${i}` },
      state: 'down' as const,
    })),
  })
  assert(items.length === 8, String(items.length))
  assert(items.every((i) => i.severity === 'critical'), 'all critical')
})

await runCase('filterHostsByQuery is case-insensitive and no-ops on blank', () => {
  const hosts = [{ host: 'WEB-1' }, { host: 'db-east' }]
  assert(filterHostsByQuery(hosts, '').length === 2, 'blank')
  assert(filterHostsByQuery(hosts, '  web ').map((h) => h.host).join() === 'WEB-1', 'web')
  assert(filterHostsByQuery(hosts, 'nope').length === 0, 'none')
})

await runCase('matchConnectionForHost prefers exact host, then name; winrm fallback', () => {
  const conns = {
    ssh: [{ id: 's1', name: 'Edge', host: '10.0.0.1' }],
    winrm: [{ id: 'w1', name: 'WS1', host: '44.197.31.152' }],
  }
  assert(matchConnectionForHost('10.0.0.1', conns)?.id === 's1', 'exact host')
  assert(matchConnectionForHost('Edge', conns)?.kind === 'ssh', 'name')
  assert(matchConnectionForHost('44.197.31.152', conns)?.kind === 'winrm', 'winrm')
  assert(matchConnectionForHost('', conns) === null, 'empty')
  assert(matchConnectionForHost('ghost', conns) === null, 'miss')
})

await runCase('headline: all-clear vs mixed counts', () => {
  assert(situationHeadline([{ id: 'clear', severity: 'info', kind: 'all-clear', title: 'All clear · 2 hosts reporting', detail: '' }]).startsWith('All clear'), 'clear')
  const h = situationHeadline([
    { id: 'a', severity: 'critical', kind: 'host-down', title: 'db is down', detail: '' },
    { id: 'b', severity: 'warning', kind: 'host-degraded', title: 'web degraded', detail: '' },
  ])
  assert(h.includes('1 critical') && h.includes('1 warning') && h.includes('db is down'), h)
})

await runCase('dashboardEmptyHints omits sections that have data', () => {
  const hints = dashboardEmptyHints({
    hosts: [{ host: 'a' }],
    slos: [],
    apm: { bottleneckServices: [{ service: 'x' }] },
    dem: { slowestPages: [] },
    clusters: [],
    capacity: [{ host: 'a', daysToFull: 10 }],
    incidents: [],
    uptime: [{ target: { name: 'a' }, state: 'up' }],
  })
  const sections = hints.map((h) => h.section)
  assert(!sections.includes('hosts'), 'hosts has data')
  assert(!sections.includes('apm'), 'apm has data')
  assert(!sections.includes('capacity'), 'capacity has data')
  assert(sections.includes('slos'), 'slos empty')
  assert(sections.includes('dem'), 'dem empty')
})

await runCase('getExtras failure is isolated: presentDashboard still works with {}', () => {
  const p = presentDashboard({ hosts: [{ host: 'a' }] }, undefined as never)
  assert(p.hostCount === 1, 'hostCount')
  assert(p.situation[0].kind === 'all-clear', p.situation[0].kind)
})

console.log('dashboardPresentation: all cases passed')
