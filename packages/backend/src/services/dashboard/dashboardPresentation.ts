/**
 * dashboardPresentation — situation-first ranking, honest empty states, and
 * RTerm-native work (playbooks / triggers / scheduled tasks / agent runs).
 *
 * Pure: no I/O. DashboardService and the HTML/in-app renderers consume this.
 * Click-through actions are data (open-host / open-connections / open-chat);
 * the UI layer executes them.
 */

export type DashboardActionType = 'open-host' | 'open-connections' | 'open-chat'

export interface DashboardAction {
  type: DashboardActionType
  /** host, playbook id, session id, or connections section */
  target?: string
  label: string
}

export type SituationSeverity = 'critical' | 'warning' | 'info'

export interface SituationItem {
  id: string
  severity: SituationSeverity
  kind:
    | 'host-down'
    | 'host-degraded'
    | 'incident'
    | 'slo-burn'
    | 'disk-full'
    | 'playbook-failed'
    | 'agent-failed'
    | 'cluster-unhealthy'
    | 'trigger-fire'
    | 'task-failed'
    | 'all-clear'
  title: string
  detail: string
  action?: DashboardAction
}

export interface WorkItem {
  id: string
  kind: 'playbook' | 'trigger' | 'scheduled-task' | 'agent-run'
  name: string
  ok: boolean | null
  at?: number | string
  detail: string
  action?: DashboardAction
}

export interface DashboardWork {
  playbooks: WorkItem[]
  triggers: WorkItem[]
  scheduledTasks: WorkItem[]
  agentRuns: WorkItem[]
}

export interface EmptyHint {
  section: string
  message: string
}

export interface DashboardExtras {
  playbooks?: Array<{
    id: string
    name: string
    lastRunAt?: string
    lastRunOk?: boolean
  }>
  scheduledTasks?: Array<{
    id: string
    name: string
    enabled?: boolean
    lastRunAt?: string
  }>
  triggers?: Array<{
    id: string
    name: string
    enabled?: boolean
    kind?: string
    lastFiredAt?: number
    fireCount?: number
  }>
  agentRuns?: Array<{
    runId: string
    sessionId: string
    status: string
    error?: string
    startedAt: number
    endedAt?: number
    inputPreview?: string
  }>
}

export interface FleetSnapshot {
  at?: number
  hosts?: Array<{
    host: string
    golden?: {
      cpuPercent?: number
      memPercent?: number
      diskPercentMax?: number
      cpuTrendPerDay?: number
      diskDaysToFull?: number
    }
    uptime?: { state?: string }
  }>
  slos?: Array<{
    sloId: string
    sli?: number
    burnRate?: number
    errorBudgetRemaining?: number
    fastBurning?: boolean
  }>
  uptime?: Array<{
    target?: { name?: string }
    state?: string
    consecutiveFailures?: number
    lastError?: string
  }>
  incidents?: Array<{
    id?: string
    title?: string
    severity?: string
    status?: string
    affected?: string[]
  }>
  apm?: { bottleneckServices?: unknown[]; slowestTraces?: unknown[] }
  dem?: { slowestPages?: unknown[]; poorPages?: unknown[] }
  clusters?: Array<{
    context?: string
    notReadyPods?: number
    crashLoopPods?: number
    totalPods?: number
  }>
  capacity?: Array<{ host: string; diskPercent?: number; daysToFull?: number }>
}

const WORK_LIMIT = 8
const SITUATION_LIMIT = 8

export function emptyHint(section: string, hasRows: boolean, message: string): EmptyHint | null {
  if (hasRows) return null
  return { section, message }
}

export function dashboardEmptyHints(state: FleetSnapshot): EmptyHint[] {
  const hints: EmptyHint[] = []
  const push = (section: string, hasRows: boolean, message: string) => {
    const h = emptyHint(section, hasRows, message)
    if (h) hints.push(h)
  }
  push(
    'hosts',
    (state.hosts?.length ?? 0) > 0,
    'No hosts reporting yet. Open a terminal so Monitor can collect CPU/mem/disk, or add a watchdog target.',
  )
  push(
    'slos',
    (state.slos?.length ?? 0) > 0,
    'No SLOs defined yet. Define an SLO to track error budget and burn rate.',
  )
  push(
    'uptime',
    (state.uptime?.length ?? 0) > 0,
    'No watchdog targets yet. Uptime probes appear here once a host is watched.',
  )
  push('incidents', (state.incidents?.length ?? 0) > 0, 'No open incidents.')
  push(
    'apm',
    (state.apm?.bottleneckServices?.length ?? 0) > 0 || (state.apm?.slowestTraces?.length ?? 0) > 0,
    'No APM spans ingested yet. Model calls and OTLP spans appear here when tracing is on.',
  )
  push(
    'dem',
    (state.dem?.slowestPages?.length ?? 0) > 0,
    'No RUM sessions yet. Core Web Vitals appear after DEM beacons are ingested.',
  )
  push(
    'clusters',
    (state.clusters?.length ?? 0) > 0,
    'No Kubernetes clusters reporting yet. Run collect_infra / kubectl ingest to populate.',
  )
  push(
    'capacity',
    (state.capacity?.length ?? 0) > 0,
    'No capacity forecast yet. Disk-days-to-full needs Monitor disk samples.',
  )
  return hints
}

export function rankSituation(state: FleetSnapshot, extras: DashboardExtras = {}): SituationItem[] {
  const items: SituationItem[] = []

  for (const u of state.uptime ?? []) {
    const name = u.target?.name
    if (!name) continue
    if (u.state === 'down') {
      items.push({
        id: `down:${name}`,
        severity: 'critical',
        kind: 'host-down',
        title: `${name} is down`,
        detail: u.lastError || `${u.consecutiveFailures ?? 0} consecutive probe failure(s)`,
        action: { type: 'open-host', target: name, label: 'Open host' },
      })
    } else if (u.state === 'degraded') {
      items.push({
        id: `deg:${name}`,
        severity: 'warning',
        kind: 'host-degraded',
        title: `${name} is degraded`,
        detail: u.lastError || 'Watchdog reports degraded',
        action: { type: 'open-host', target: name, label: 'Open host' },
      })
    }
  }

  for (const i of state.incidents ?? []) {
    const sev = String(i.severity || 'sev3')
    const critical = sev === 'sev1' || sev === 'sev2'
    items.push({
      id: `inc:${i.id || i.title || 'unknown'}`,
      severity: critical ? 'critical' : 'warning',
      kind: 'incident',
      title: String(i.title || 'Open incident'),
      detail: `${sev} · ${(i.affected || []).join(', ') || 'no affected hosts'}`,
      action: { type: 'open-chat', label: 'Ask agent' },
    })
  }

  for (const s of state.slos ?? []) {
    if (!s.fastBurning) continue
    items.push({
      id: `slo:${s.sloId}`,
      severity: 'critical',
      kind: 'slo-burn',
      title: `SLO ${s.sloId} is fast-burning`,
      detail: `burn ${s.burnRate != null ? s.burnRate.toFixed(2) : '—'}x · budget ${
        s.errorBudgetRemaining != null ? Math.round(s.errorBudgetRemaining * 100) : '—'
      }%`,
      action: { type: 'open-connections', target: 'playbooks', label: 'Playbooks' },
    })
  }

  for (const c of state.capacity ?? []) {
    if (c.daysToFull != null && c.daysToFull < 7) {
      items.push({
        id: `disk:${c.host}`,
        severity: c.daysToFull < 2 ? 'critical' : 'warning',
        kind: 'disk-full',
        title: `${c.host} disk full in ${c.daysToFull.toFixed(1)}d`,
        detail: `disk ${c.diskPercent != null ? c.diskPercent.toFixed(1) : '—'}%`,
        action: { type: 'open-host', target: c.host, label: 'Open host' },
      })
    }
  }

  for (const cl of state.clusters ?? []) {
    const crash = cl.crashLoopPods ?? 0
    const notReady = cl.notReadyPods ?? 0
    if (crash > 0 || notReady > 0) {
      items.push({
        id: `k8s:${cl.context || 'cluster'}`,
        severity: crash > 0 ? 'critical' : 'warning',
        kind: 'cluster-unhealthy',
        title: `${cl.context || 'cluster'} unhealthy`,
        detail: `${crash} crashloop · ${notReady} not ready · ${cl.totalPods ?? 0} pods`,
      })
    }
  }

  for (const p of extras.playbooks ?? []) {
    if (p.lastRunOk === false) {
      items.push({
        id: `pb:${p.id}`,
        severity: 'warning',
        kind: 'playbook-failed',
        title: `Playbook "${p.name}" last run failed`,
        detail: p.lastRunAt ? `last run ${p.lastRunAt}` : 'last run failed',
        action: { type: 'open-connections', target: 'playbooks', label: 'Open playbooks' },
      })
    }
  }

  for (const r of extras.agentRuns ?? []) {
    if (r.status === 'failed' || r.status === 'aborted') {
      items.push({
        id: `run:${r.runId}`,
        severity: r.status === 'failed' ? 'warning' : 'info',
        kind: 'agent-failed',
        title: `Agent run ${r.status}`,
        detail: r.error || r.inputPreview || r.sessionId,
        action: { type: 'open-chat', target: r.sessionId, label: 'Open chat' },
      })
    }
  }

  const order: Record<SituationSeverity, number> = { critical: 0, warning: 1, info: 2 }
  items.sort((a, b) => order[a.severity] - order[b.severity])
  const sliced = items.slice(0, SITUATION_LIMIT)
  if (sliced.length === 0) {
    const n = state.hosts?.length ?? 0
    return [
      {
        id: 'clear',
        severity: 'info',
        kind: 'all-clear',
        title: n > 0 ? `All clear · ${n} host${n === 1 ? '' : 's'} reporting` : 'All clear · nothing to act on',
        detail: 'No down hosts, fast-burning SLOs, or failed runs.',
      },
    ]
  }
  return sliced
}

export function collectWork(extras: DashboardExtras = {}): DashboardWork {
  const playbooks: WorkItem[] = (extras.playbooks ?? [])
    .filter((p) => p.lastRunAt)
    .sort((a, b) => String(b.lastRunAt).localeCompare(String(a.lastRunAt)))
    .slice(0, WORK_LIMIT)
    .map((p) => ({
      id: p.id,
      kind: 'playbook' as const,
      name: p.name,
      ok: p.lastRunOk ?? null,
      at: p.lastRunAt,
      detail: p.lastRunOk === false ? 'failed' : p.lastRunOk === true ? 'ok' : 'ran',
      action: { type: 'open-connections', target: 'playbooks', label: 'Open' },
    }))

  const triggers: WorkItem[] = (extras.triggers ?? [])
    .filter((t) => t.lastFiredAt || (t.fireCount ?? 0) > 0)
    .sort((a, b) => (b.lastFiredAt ?? 0) - (a.lastFiredAt ?? 0))
    .slice(0, WORK_LIMIT)
    .map((t) => ({
      id: t.id,
      kind: 'trigger' as const,
      name: t.name,
      ok: true,
      at: t.lastFiredAt,
      detail: `${t.kind || 'trigger'} · fired ${t.fireCount ?? 0}×`,
      action: { type: 'open-connections', target: 'triggers', label: 'Open' },
    }))

  const scheduledTasks: WorkItem[] = (extras.scheduledTasks ?? [])
    .filter((t) => t.lastRunAt)
    .sort((a, b) => String(b.lastRunAt).localeCompare(String(a.lastRunAt)))
    .slice(0, WORK_LIMIT)
    .map((t) => ({
      id: t.id,
      kind: 'scheduled-task' as const,
      name: t.name,
      ok: t.enabled === false ? null : true,
      at: t.lastRunAt,
      detail: t.enabled === false ? 'disabled' : 'last run',
      action: { type: 'open-connections', target: 'scheduledTasks', label: 'Open' },
    }))

  const agentRuns: WorkItem[] = (extras.agentRuns ?? [])
    .slice()
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
    .slice(0, WORK_LIMIT)
    .map((r) => ({
      id: r.runId,
      kind: 'agent-run' as const,
      name: r.inputPreview?.slice(0, 60) || r.runId,
      ok: r.status === 'completed' ? true : r.status === 'failed' || r.status === 'aborted' ? false : null,
      at: r.endedAt || r.startedAt,
      detail: r.status + (r.error ? ` · ${r.error}` : ''),
      action: { type: 'open-chat', target: r.sessionId, label: 'Open chat' },
    }))

  return { playbooks, triggers, scheduledTasks, agentRuns }
}

export function situationHeadline(items: SituationItem[]): string {
  const crit = items.filter((i) => i.severity === 'critical' && i.kind !== 'all-clear').length
  const warn = items.filter((i) => i.severity === 'warning').length
  if (items.length === 1 && items[0].kind === 'all-clear') return items[0].title
  const parts: string[] = []
  if (crit) parts.push(`${crit} critical`)
  if (warn) parts.push(`${warn} warning`)
  const top = items[0]
  return `${parts.join(' · ') || 'attention'} · ${top.title}`
}

export function filterHostsByQuery<T extends { host: string }>(hosts: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...hosts]
  return hosts.filter((h) => h.host.toLowerCase().includes(q))
}

/** Match a dashboard host name to a saved SSH/WinRM connection (by host field or name). */
export function matchConnectionForHost(
  host: string,
  connections: { ssh?: Array<{ id: string; name: string; host: string }>; winrm?: Array<{ id: string; name: string; host: string }> },
): { kind: 'ssh' | 'winrm'; id: string } | null {
  const needle = host.trim().toLowerCase()
  if (!needle) return null
  const ssh = connections.ssh ?? []
  const winrm = connections.winrm ?? []
  const sshHit = ssh.find((c) => c.host.toLowerCase() === needle || c.name.toLowerCase() === needle || c.host.toLowerCase().startsWith(needle.split(':')[0]))
  if (sshHit) return { kind: 'ssh', id: sshHit.id }
  const winrmHit = winrm.find((c) => c.host.toLowerCase() === needle || c.name.toLowerCase() === needle)
  if (winrmHit) return { kind: 'winrm', id: winrmHit.id }
  return null
}

export function presentDashboard(state: FleetSnapshot, extras: DashboardExtras = {}) {
  const situation = rankSituation(state, extras)
  return {
    situation,
    headline: situationHeadline(situation),
    work: collectWork(extras),
    empty: dashboardEmptyHints(state),
    hostCount: state.hosts?.length ?? 0,
    downCount: (state.uptime ?? []).filter((u) => u.state === 'down').length,
    degradedCount: (state.uptime ?? []).filter((u) => u.state === 'degraded').length,
  }
}
