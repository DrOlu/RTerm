/**
 * liveDashboardHub — live, multi-client dashboard state hub (Tier 2). The
 * existing dashboard renders a self-refreshing static page; this hub turns it
 * into a push model: it holds the unified dashboard state, lets many clients
 * (web UI, TUI, mobile) subscribe with per-client filters, and pushes only the
 * state slices each subscriber cares about on every update.
 *
 * Pure + injectable: the state source and the per-client send function are
 * injected (the send is wired to the WebSocket gateway in the runtime).
 */

export interface DashboardFilter {
  /** only these sections (e.g. 'goldenSignals','incidents','slo','apm','cloud'). */
  sections?: string[]
  /** only this host (for host-scoped views). */
  host?: string
}

export interface Subscriber {
  id: string
  filter?: DashboardFilter
  /** push a (filtered) state payload to this client. */
  send: (payload: unknown) => void
}

export interface LiveDashboardHubDeps<TState = Record<string, unknown>> {
  /** produce the current full state. */
  getState: () => TState | Promise<TState>
  /** optional: extract a named section from the state (default: state[section]). */
  getSection?: (state: TState, section: string) => unknown
  /** optional: filter a state payload down to one host (default: pass-through). */
  scopeToHost?: (state: TState, host: string) => unknown
  /** replay the last pushed state to new subscribers (default true). */
  replayOnSubscribe?: boolean
}

export class LiveDashboardHub<TState = Record<string, unknown>> {
  private readonly getState: LiveDashboardHubDeps<TState>['getState']
  private readonly getSection?: LiveDashboardHubDeps<TState>['getSection']
  private readonly scopeToHost?: LiveDashboardHubDeps<TState>['scopeToHost']
  private readonly replayOnSubscribe: boolean
  private readonly subscribers = new Map<string, Subscriber>()
  private lastPayload: TState | null = null
  private pushCount = 0

  constructor(deps: LiveDashboardHubDeps<TState>) {
    if (!deps.getState) throw new Error('liveDashboardHub needs getState')
    this.getState = deps.getState
    this.getSection = deps.getSection
    this.scopeToHost = deps.scopeToHost
    this.replayOnSubscribe = deps.replayOnSubscribe ?? true
  }

  /** Number of connected subscribers. */
  subscriberCount(): number {
    return this.subscribers.size
  }

  /** How many times state has been pushed to all subscribers. */
  pushes(): number {
    return this.pushCount
  }

  /** Apply a subscriber's filter to a full state payload. */
  private applyFilter(state: TState, filter?: DashboardFilter): unknown {
    let out: unknown = state
    if (filter?.host && this.scopeToHost) {
      out = this.scopeToHost(state, filter.host)
    }
    if (filter?.sections && filter.sections.length > 0) {
      const sliced: Record<string, unknown> = {}
      for (const s of filter.sections) {
        sliced[s] = this.getSection ? this.getSection(state, s) : (state as Record<string, unknown>)[s]
      }
      out = sliced
    }
    return out
  }

  /** Subscribe a client. Immediately replays the latest state (if any). */
  async subscribe(sub: Subscriber): Promise<() => void> {
    if (!sub || !sub.id) throw new Error('subscriber needs an id')
    if (typeof sub.send !== 'function') throw new Error('subscriber needs a send function')
    this.subscribers.set(sub.id, sub)
    if (this.replayOnSubscribe) {
      const state = this.lastPayload ?? (await this.getState())
      sub.send(this.applyFilter(state, sub.filter))
    }
    return () => this.unsubscribe(sub.id)
  }

  /** Unsubscribe a client. Returns whether it was subscribed. */
  unsubscribe(id: string): boolean {
    return this.subscribers.delete(id)
  }

  /**
   * Publish the current state to all subscribers, each receiving its filtered
   * slice. Call on every state change (monitor snapshot, incident, etc.).
   */
  async publish(): Promise<number> {
    const state = await this.getState()
    this.lastPayload = state
    this.pushCount++
    let delivered = 0
    for (const sub of this.subscribers.values()) {
      try {
        sub.send(this.applyFilter(state, sub.filter))
        delivered++
      } catch {
        // a dead subscriber shouldn't break the broadcast; caller prunes via unsubscribe
      }
    }
    return delivered
  }

  /** The last published full state (for late joiners / snapshots). */
  lastState(): TState | null {
    return this.lastPayload
  }
}
