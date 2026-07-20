import { randomUUID } from 'crypto'

/**
 * IncidentLedger — incident management (Tier 2 SRE).
 *
 * Auto-creates incidents from signals (watchdog down, SLO fast-burn, trigger
 * fire), tracks them through open → mitigated → resolved, records a timeline of
 * events, links evidence (logs, snapshots, changes), links the runbook playbook
 * for that failure class, and supports AI root-cause notes + auto-generated
 * postmortems. Pure + injectable; persist via a SQLite store (same pattern as
 * changeLedger/agentRunLedger).
 */

export type IncidentStatus = 'open' | 'mitigated' | 'resolved'
export type IncidentSeverity = 'sev1' | 'sev2' | 'sev3' | 'sev4'

export interface TimelineEvent {
  at: number
  kind: 'detected' | 'action' | 'note' | 'mitigated' | 'resolved' | 'rca' | 'evidence'
  text: string
  actor?: string
}

export interface Incident {
  id: string
  title: string
  severity: IncidentSeverity
  status: IncidentStatus
  /** affected host(s) / service(s). */
  affected: string[]
  /** the signal that created it (watchdog/slo/trigger/manual). */
  source: string
  /** the playbook/runbook to run for this failure class (optional). */
  runbookPlaybookId?: string
  /** AI root-cause analysis (filled by the agent). */
  rca?: string
  createdAt: number
  mitigatedAt?: number
  resolvedAt?: number
  timeline: TimelineEvent[]
}

export interface IncidentLedgerOptions {
  now?: () => number
  historyLimit?: number
}

const DEFAULT_LIMIT = 500

export class IncidentLedger {
  private readonly incidents = new Map<string, Incident>()
  private readonly order: string[] = []
  private readonly now: () => number
  private readonly historyLimit: number

  constructor(opts: IncidentLedgerOptions = {}) {
    this.now = opts.now ?? (() => Date.now())
    this.historyLimit = opts.historyLimit ?? DEFAULT_LIMIT
  }

  /** Create (or return the existing open incident for the same title+source). */
  create(input: {
    title: string
    severity?: IncidentSeverity
    affected?: string[]
    source: string
    runbookPlaybookId?: string
    detectText?: string
  }): { incident: Incident; isNew: boolean } {
    const existing = Array.from(this.incidents.values()).find(
      (i) => i.status !== 'resolved' && i.title === input.title && i.source === input.source,
    )
    if (existing) {
      this.addEvent(existing.id, 'detected', input.detectText ?? 'repeat detection')
      return { incident: existing, isNew: false }
    }
    const at = this.now()
    const inc: Incident = {
      id: `inc-${randomUUID().slice(0, 8)}`,
      title: input.title,
      severity: input.severity ?? 'sev3',
      status: 'open',
      affected: input.affected ?? [],
      source: input.source,
      ...(input.runbookPlaybookId ? { runbookPlaybookId: input.runbookPlaybookId } : {}),
      createdAt: at,
      timeline: [{ at, kind: 'detected', text: input.detectText ?? input.title }],
    }
    this.incidents.set(inc.id, inc)
    this.order.push(inc.id)
    // ring-buffer: drop oldest resolved incidents beyond the limit
    while (this.order.length > this.historyLimit) {
      const oldest = this.order[0]
      const o = this.incidents.get(oldest)
      if (o && o.status === 'resolved') { this.order.shift(); this.incidents.delete(oldest) } else break
    }
    return { incident: inc, isNew: true }
  }

  get(id: string): Incident | undefined {
    return this.incidents.get(id)
  }

  list(filter: { status?: IncidentStatus } = {}): readonly Incident[] {
    const all = this.order.map((id) => this.incidents.get(id)!).filter(Boolean)
    return filter.status ? all.filter((i) => i.status === filter.status) : all
  }

  addEvent(id: string, kind: TimelineEvent['kind'], text: string, actor?: string): boolean {
    const inc = this.incidents.get(id)
    if (!inc) return false
    inc.timeline.push({ at: this.now(), kind, text, ...(actor ? { actor } : {}) })
    return true
  }

  linkRunbook(id: string, playbookId: string): boolean {
    const inc = this.incidents.get(id)
    if (!inc) return false
    inc.runbookPlaybookId = playbookId
    this.addEvent(id, 'action', `linked runbook ${playbookId}`)
    return true
  }

  setRca(id: string, rca: string, actor?: string): boolean {
    const inc = this.incidents.get(id)
    if (!inc) return false
    inc.rca = rca
    this.addEvent(id, 'rca', rca, actor)
    return true
  }

  addEvidence(id: string, evidence: string): boolean {
    return this.addEvent(id, 'evidence', evidence)
  }

  mitigate(id: string, actor?: string): boolean {
    const inc = this.incidents.get(id)
    if (!inc || inc.status !== 'open') return false
    inc.status = 'mitigated'
    inc.mitigatedAt = this.now()
    this.addEvent(id, 'mitigated', 'incident mitigated', actor)
    return true
  }

  resolve(id: string, actor?: string): boolean {
    const inc = this.incidents.get(id)
    if (!inc || inc.status === 'resolved') return false
    inc.status = 'resolved'
    inc.resolvedAt = this.now()
    this.addEvent(id, 'resolved', 'incident resolved', actor)
    return true
  }

  /** Auto-generate a postmortem doc from the incident's timeline + RCA. */
  postmortem(id: string): string | undefined {
    const inc = this.incidents.get(id)
    if (!inc) return undefined
    const dur = (a?: number, b?: number) => (a && b ? `${Math.round((b - a) / 1000)}s` : '—')
    const lines: string[] = [
      `# Postmortem: ${inc.title}`,
      ``,
      `**Severity:** ${inc.severity}  **Status:** ${inc.status}  **Source:** ${inc.source}`,
      `**Affected:** ${inc.affected.join(', ') || '—'}`,
      `**Opened:** ${new Date(inc.createdAt).toISOString()}`,
      inc.mitigatedAt ? `**Mitigated:** ${new Date(inc.mitigatedAt).toISOString()} (after ${dur(inc.createdAt, inc.mitigatedAt)})` : '',
      inc.resolvedAt ? `**Resolved:** ${new Date(inc.resolvedAt).toISOString()} (after ${dur(inc.createdAt, inc.resolvedAt)})` : '',
      ``,
      `## Root cause`,
      inc.rca ?? 'Not yet determined.',
      ``,
      `## Timeline`,
      ...inc.timeline.map((e) => `- ${new Date(e.at).toISOString()} [${e.kind}] ${e.text}${e.actor ? ` (${e.actor})` : ''}`),
      ``,
      inc.runbookPlaybookId ? `## Runbook\nLinked playbook: ${inc.runbookPlaybookId}` : '',
    ]
    return lines.filter((l) => l !== '').join('\n')
  }

  clear(): void {
    this.incidents.clear()
    this.order.length = 0
  }
}
