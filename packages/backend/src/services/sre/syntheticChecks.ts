import type { LatencySample } from './goldenSignals'

/**
 * SyntheticChecks — Tier 4 SRE: scripted blackbox probes (http/tcp/ssh/command)
 * against endpoints from any zone outpost, on a schedule. Results feed the SLO
 * SLI source (good/total events) and the golden-signal latency/error series.
 *
 * Pure + injectable: probe executors are injected; the service runs checks,
 * records results (latency + ok), and exposes the series + SLI counts. Uses an
 * injected `now` for deterministic tests.
 */

export type CheckKind = 'http' | 'tcp' | 'ssh' | 'command'

export interface SyntheticCheck {
  id: string
  name: string
  kind: CheckKind
  address: string
  expect?: number
  intervalMs?: number
  host: string
}

export interface CheckResult {
  checkId: string
  at: number
  ok: boolean
  latencyMs: number
  error?: string
}

export interface SyntheticDeps {
  probeHttp?: (url: string) => Promise<number>
  probeTcp?: (host: string, port: number) => Promise<boolean>
  probeSsh?: (name: string) => Promise<boolean>
  probeCommand?: (command: string) => Promise<boolean>
  now?: () => number
  /** max results retained per check (default 1000). */
  perCheckLimit?: number
}

const DEFAULT_LIMIT = 1000

export class SyntheticChecks {
  private readonly checks = new Map<string, SyntheticCheck>()
  private readonly results = new Map<string, CheckResult[]>()
  private readonly now: () => number
  private readonly perCheckLimit: number

  constructor(private readonly deps: SyntheticDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.perCheckLimit = deps.perCheckLimit ?? DEFAULT_LIMIT
  }

  add(check: SyntheticCheck): SyntheticCheck {
    this.checks.set(check.id, check)
    return check
  }

  remove(id: string): boolean {
    this.results.delete(id)
    return this.checks.delete(id)
  }

  list(): readonly SyntheticCheck[] {
    return Array.from(this.checks.values())
  }

  /** Run one check, record the result, return it. */
  async run(id: string): Promise<CheckResult> {
    const c = this.checks.get(id)
    if (!c) throw new Error(`no synthetic check "${id}"`)
    const startedAt = this.now()
    let ok = false
    let err: string | undefined
    try {
      ok = await this.exec(c)
    } catch (e) {
      err = e instanceof Error ? e.message : String(e)
    }
    const res: CheckResult = { checkId: id, at: this.now(), ok, latencyMs: this.now() - startedAt, ...(err ? { error: err } : {}) }
    let arr = this.results.get(id)
    if (!arr) { arr = []; this.results.set(id, arr) }
    arr.push(res)
    if (arr.length > this.perCheckLimit) arr.splice(0, arr.length - this.perCheckLimit)
    return res
  }

  /** Run all checks that are due (intervalMs elapsed since last result). */
  async runDue(): Promise<CheckResult[]> {
    const out: CheckResult[] = []
    for (const c of this.checks.values()) {
      const arr = this.results.get(c.id)
      const last = arr && arr.length > 0 ? arr[arr.length - 1].at : 0
      if (this.now() - last >= (c.intervalMs ?? 60_000)) {
        out.push(await this.run(c.id))
      }
    }
    return out
  }

  private async exec(c: SyntheticCheck): Promise<boolean> {
    switch (c.kind) {
      case 'http': {
        if (!this.deps.probeHttp) throw new Error('no http prober')
        const code = await this.deps.probeHttp(c.address)
        const expect = c.expect ?? 200
        return code === expect || (expect === 200 && code >= 200 && code < 400)
      }
      case 'tcp': {
        if (!this.deps.probeTcp) throw new Error('no tcp prober')
        return this.deps.probeTcp(c.address, c.expect ?? 22)
      }
      case 'ssh': {
        if (!this.deps.probeSsh) throw new Error('no ssh prober')
        return this.deps.probeSsh(c.address)
      }
      case 'command': {
        if (!this.deps.probeCommand) throw new Error('no command prober')
        return this.deps.probeCommand(c.address)
      }
      default:
        throw new Error(`unknown check kind ${(c as { kind: string }).kind}`)
    }
  }

  /** SLI event counts for a host over a window (good/total). */
  sliCounts(host: string, sinceMs: number): { good: number; total: number } {
    let good = 0
    let total = 0
    for (const c of this.checks.values()) {
      if (c.host !== host) continue
      for (const r of this.results.get(c.id) ?? []) {
        if (r.at < sinceMs) continue
        total += 1
        if (r.ok) good += 1
      }
    }
    return { good, total }
  }

  /** Latency series for a host over a window (for golden signals). */
  latencySeries(host: string, sinceMs: number): LatencySample[] {
    const out: LatencySample[] = []
    for (const c of this.checks.values()) {
      if (c.host !== host) continue
      for (const r of this.results.get(c.id) ?? []) {
        if (r.at < sinceMs) continue
        out.push({ at: r.at, ms: r.latencyMs })
      }
    }
    return out.sort((a, b) => a.at - b.at)
  }

  /** Error rate (fraction of failed results) for a host over a window. */
  errorRate(host: string, sinceMs: number): number | undefined {
    const { good, total } = this.sliCounts(host, sinceMs)
    return total > 0 ? 1 - good / total : undefined
  }

  /** Latest result for a check. */
  latest(id: string): CheckResult | undefined {
    const arr = this.results.get(id)
    return arr && arr.length > 0 ? arr[arr.length - 1] : undefined
  }

  clear(): void {
    this.checks.clear()
    this.results.clear()
  }
}
