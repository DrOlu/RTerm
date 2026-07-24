/**
 * escalationService — incident paging: on-call rotations, acknowledgement,
 * multi-level escalation chains, and paging channels (Tier 1). Turns an alert
 * that lands in a Slack channel at 3am into actual incident response.
 *
 * A page is raised for an incident and routed to the current on-call level.
 * If it isn't acknowledged within the level's ack deadline, it escalates to
 * the next level. Ack/resolve stops the chain. Pure + injectable: paging
 * senders and the clock are injected.
 */

import { randomUUID } from 'crypto'

export interface OnCallTarget {
  /** a person, team, or channel identifier (email, slack user, phone). */
  id: string
  /** how to reach them (page channel name). */
  channel: string
}

export interface EscalationLevel {
  /** who is paged at this level. */
  targets: OnCallTarget[]
  /** ms to wait for ack before escalating to the next level. */
  ackTimeoutMs: number
}

export interface EscalationPolicy {
  id: string
  name: string
  levels: EscalationLevel[]
  /** repeat from the top if the last level times out (default false). */
  repeat?: boolean
}

export type PageStatus = 'open' | 'acknowledged' | 'resolved' | 'expired'

export interface Page {
  id: string
  incidentId: string
  policyId: string
  /** current escalation level index (0-based). */
  levelIndex: number
  status: PageStatus
  title: string
  severity: string
  createdAt: number
  /** when the current level was (re)entered. */
  levelEnteredAt: number
  acknowledgedBy?: string
  acknowledgedAt?: number
  resolvedAt?: number
  /** number of times this page escalated. */
  escalations: number
}

export interface PageChannel {
  name: string
  send: (target: OnCallTarget, page: Page, level: number) => Promise<string>
}

export interface EscalationServiceDeps {
  channels?: PageChannel[]
  now?: () => number
  /** cap on stored pages (default 500). */
  limit?: number
  /** called whenever a page is (re)sent at a level. */
  onNotify?: (page: Page, level: number, targets: OnCallTarget[]) => void
}

export class EscalationService {
  private readonly policies = new Map<string, EscalationPolicy>()
  private readonly pages = new Map<string, Page>()
  private readonly channels: Map<string, PageChannel>
  private readonly now: () => number
  private readonly limit: number
  private readonly onNotify?: EscalationServiceDeps['onNotify']

  constructor(deps: EscalationServiceDeps = {}) {
    this.channels = new Map((deps.channels ?? []).map((c) => [c.name, c]))
    this.now = deps.now ?? Date.now
    this.limit = deps.limit ?? 500
    this.onNotify = deps.onNotify
  }

  /** Register/replace an escalation policy. Validates structure. */
  registerPolicy(policy: EscalationPolicy): void {
    if (!policy.id) throw new Error('policy needs an id')
    if (!Array.isArray(policy.levels) || policy.levels.length === 0) {
      throw new Error(`policy ${policy.id} needs at least one level`)
    }
    for (const [i, lvl] of policy.levels.entries()) {
      if (!Array.isArray(lvl.targets) || lvl.targets.length === 0) {
        throw new Error(`policy ${policy.id} level ${i} has no targets`)
      }
      if (!(lvl.ackTimeoutMs > 0)) throw new Error(`policy ${policy.id} level ${i} bad ackTimeoutMs`)
    }
    this.policies.set(policy.id, policy)
  }

  getPolicy(id: string): EscalationPolicy | undefined {
    return this.policies.get(id)
  }

  listPolicies(): EscalationPolicy[] {
    return [...this.policies.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Raise a page for an incident under a policy. Sends level-0 notifications. */
  async page(input: {
    incidentId: string
    policyId: string
    title: string
    severity: string
  }): Promise<Page> {
    const policy = this.policies.get(input.policyId)
    if (!policy) throw new Error(`unknown escalation policy: ${input.policyId}`)
    const at = this.now()
    const page: Page = {
      id: randomUUID(),
      incidentId: input.incidentId,
      policyId: input.policyId,
      levelIndex: 0,
      status: 'open',
      title: input.title,
      severity: input.severity,
      createdAt: at,
      levelEnteredAt: at,
      escalations: 0,
    }
    this.pages.set(page.id, page)
    if (this.pages.size > this.limit) {
      // evict oldest resolved/expired first, else oldest
      const resolved = [...this.pages.values()].filter((p) => p.status === 'resolved' || p.status === 'expired')
      const victim = (resolved[0] ?? [...this.pages.values()][0])
      if (victim && victim.id !== page.id) this.pages.delete(victim.id)
    }
    await this.notifyLevel(page)
    return page
  }

  private async notifyLevel(page: Page): Promise<void> {
    const policy = this.policies.get(page.policyId)
    if (!policy) return
    const level = policy.levels[page.levelIndex]
    if (!level) return
    this.onNotify?.(page, page.levelIndex, level.targets)
    for (const target of level.targets) {
      const ch = this.channels.get(target.channel)
      if (ch) await ch.send(target, page, page.levelIndex)
    }
  }

  /** Acknowledge a page (stops escalation). Returns updated page. */
  acknowledge(pageId: string, by: string): Page {
    const p = this.pages.get(pageId)
    if (!p) throw new Error(`page not found: ${pageId}`)
    if (p.status !== 'open') throw new Error(`page ${pageId} is ${p.status}, cannot ack`)
    p.status = 'acknowledged'
    p.acknowledgedBy = by
    p.acknowledgedAt = this.now()
    return p
  }

  /** Resolve a page (incident handled). */
  resolve(pageId: string): Page {
    const p = this.pages.get(pageId)
    if (!p) throw new Error(`page not found: ${pageId}`)
    if (p.status === 'resolved') return p
    p.status = 'resolved'
    p.resolvedAt = this.now()
    return p
  }

  /**
   * Advance the escalation clock: any open page whose current level has exceeded
   * its ack timeout escalates to the next level (and re-notifies). Returns the
   * pages that escalated this tick. Pure w.r.t. injected clock.
   */
  async tick(): Promise<Page[]> {
    const escalated: Page[] = []
    const at = this.now()
    for (const p of this.pages.values()) {
      if (p.status !== 'open') continue
      const policy = this.policies.get(p.policyId)
      if (!policy) continue
      const level = policy.levels[p.levelIndex]
      if (!level) continue
      if (at - p.levelEnteredAt < level.ackTimeoutMs) continue
      // time out this level
      if (p.levelIndex + 1 < policy.levels.length) {
        p.levelIndex += 1
        p.escalations += 1
        p.levelEnteredAt = at
        await this.notifyLevel(p)
        escalated.push(p)
      } else if (policy.repeat) {
        p.levelIndex = 0
        p.escalations += 1
        p.levelEnteredAt = at
        await this.notifyLevel(p)
        escalated.push(p)
      } else {
        p.status = 'expired'
        escalated.push(p)
      }
    }
    return escalated
  }

  getPage(id: string): Page | undefined {
    return this.pages.get(id)
  }

  /** Pages for an incident (any status). */
  pagesForIncident(incidentId: string): Page[] {
    return [...this.pages.values()].filter((p) => p.incidentId === incidentId)
  }

  /** Currently-open (unacked, unexpired) pages. */
  openPages(): Page[] {
    return [...this.pages.values()].filter((p) => p.status === 'open')
  }
}
