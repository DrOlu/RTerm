import { randomUUID } from 'crypto'

/**
 * UptimeWatchdog — liveness/heartbeat probes for hosts and endpoints (Tier 1 SRE).
 *
 * Runs periodic liveness checks (tcp / ssh / http / custom command) against a
 * set of targets, tracks up/degraded/down state transitions, and fires a callback
 * when a host changes state (so an alert/incident can be raised). Pure +
 * injectable: probe functions are injected per kind; the watchdog just schedules
 * evaluation and manages state. Works with an injected `now` for deterministic tests.
 */

export type ProbeKind = 'tcp' | 'ssh' | 'http' | 'command'

export interface WatchdogTarget {
  id: string
  name: string
  kind: ProbeKind
  /** tcp: host; ssh: connection name; http: url; command: free-form command. */
  address: string
  /** expected: tcp port, ssh none, http status code, command exit code 0. */
  expect?: number
  /** consecutive failures before the host is considered down (default 3). */
  downAfter?: number
  /** interval between probes in ms (default 60_000). */
  intervalMs?: number
}

export type HostState = 'up' | 'degraded' | 'down' | 'unknown'

export interface HostStatus {
  target: WatchdogTarget
  state: HostState
  consecutiveFailures: number
  lastProbeAt?: number
  lastOkAt?: number
  lastError?: string
  /** ms of the last successful probe. */
  lastLatencyMs?: number
}

export interface WatchdogDeps {
  /** returns true when the TCP port is reachable. */
  probeTcp?: (host: string, port: number) => Promise<boolean>
  /** returns true when the SSH connection is up. */
  probeSsh?: (connectionName: string) => Promise<boolean>
  /** returns the HTTP status code (or throws). */
  probeHttp?: (url: string) => Promise<number>
  /** returns true when the command exits 0. */
  probeCommand?: (command: string) => Promise<boolean>
  /** fired on any state transition. */
  onTransition?: (status: HostStatus, from: HostState, to: HostState) => void
  now?: () => number
}

export class UptimeWatchdog {
  private readonly targets = new Map<string, WatchdogTarget>()
  private readonly status = new Map<string, HostStatus>()
  private readonly now: () => number

  constructor(private readonly deps: WatchdogDeps) {
    this.now = deps.now ?? (() => Date.now())
  }

  upsert(target: Omit<WatchdogTarget, 'id'> & { id?: string }): WatchdogTarget {
    const t: WatchdogTarget = {
      ...target,
      id: target.id ?? `wt-${randomUUID().slice(0, 8)}`,
      downAfter: target.downAfter ?? 3,
      intervalMs: target.intervalMs ?? 60_000,
    }
    this.targets.set(t.id, t)
    if (!this.status.has(t.id)) {
      this.status.set(t.id, { target: t, state: 'unknown', consecutiveFailures: 0 })
    }
    return t
  }

  remove(id: string): boolean {
    this.status.delete(id)
    return this.targets.delete(id)
  }

  list(): readonly WatchdogTarget[] {
    return Array.from(this.targets.values())
  }

  getStatus(id: string): HostStatus | undefined {
    return this.status.get(id)
  }

  allStatus(): readonly HostStatus[] {
    return Array.from(this.status.values())
  }

  /** Probe one target once and update its state (fires onTransition on change). */
  async probe(id: string): Promise<HostStatus> {
    const t = this.targets.get(id)
    if (!t) throw new Error(`no watchdog target "${id}"`)
    const st = this.status.get(id)!
    const prev = st.state
    const startedAt = this.now()
    let ok = false
    let err: string | undefined
    try {
      ok = await this.runProbe(t)
    } catch (e) {
      ok = false
      err = e instanceof Error ? e.message : String(e)
    }
    const at = this.now()

    st.lastProbeAt = at
    if (ok) {
      st.consecutiveFailures = 0
      st.lastOkAt = at
      st.lastLatencyMs = at - startedAt
      st.lastError = undefined
      st.state = 'up'
    } else {
      st.consecutiveFailures += 1
      st.lastError = err
      const downAfter = t.downAfter ?? 3
      st.state = st.consecutiveFailures >= downAfter ? 'down' : 'degraded'
    }

    if (prev !== st.state) {
      try { this.deps.onTransition?.(st, prev, st.state) } catch { /* best-effort */ }
    }
    return st
  }

  /** Probe every target that is due (intervalMs elapsed since last probe). */
  async probeDue(): Promise<HostStatus[]> {
    const out: HostStatus[] = []
    for (const t of this.targets.values()) {
      const st = this.status.get(t.id)!
      const last = st.lastProbeAt ?? 0
      if (this.now() - last >= (t.intervalMs ?? 60_000)) {
        out.push(await this.probe(t.id))
      }
    }
    return out
  }

  private async runProbe(t: WatchdogTarget): Promise<boolean> {
    switch (t.kind) {
      case 'tcp': {
        if (!this.deps.probeTcp) throw new Error('no tcp prober configured')
        return this.deps.probeTcp(t.address, t.expect ?? 22)
      }
      case 'ssh': {
        if (!this.deps.probeSsh) throw new Error('no ssh prober configured')
        return this.deps.probeSsh(t.address)
      }
      case 'http': {
        if (!this.deps.probeHttp) throw new Error('no http prober configured')
        const code = await this.deps.probeHttp(t.address)
        const expect = t.expect ?? 200
        return code === expect || (expect === 200 && code >= 200 && code < 400)
      }
      case 'command': {
        if (!this.deps.probeCommand) throw new Error('no command prober configured')
        return this.deps.probeCommand(t.address)
      }
      default:
        throw new Error(`unknown probe kind ${(t as { kind: string }).kind}`)
    }
  }
}
