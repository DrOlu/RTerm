import { randomUUID } from 'crypto'
import type { TriggerEntry } from '../../types'

export type { TriggerEntry } from '../../types'
export type TriggerKind = TriggerEntry['kind']
export type TriggerAction = TriggerEntry['action']

/**
 * TriggerEngine — event-driven automation.
 *
 * Fires a playbook (or a MOP change proposal) when an event matches a trigger
 * rule. Events can come from:
 *   - terminal output pattern  (kind: 'pattern', source: terminal data stream)
 *   - monitor threshold        (kind: 'threshold', source: monitor snapshots)
 *   - manual / webhook         (kind: 'webhook', source: trigger:fire RPC)
 *   - schedule                 (kind: 'schedule', handled by the cron scheduler;
 *                               included here for a unified trigger model)
 *
 * Design goals:
 *   - Pure + injectable: no direct TerminalService/Monitor dependency. Feed it
 *     events via handleTerminalData / handleMonitorSnapshot / fire; it decides
 *     matches and invokes an injected `runPlaybook` / `proposeChange` callback.
 *   - Safe: per-trigger cooldown + a global concurrency cap so a noisy log or a
 *     flapping metric can't spawn an unbounded remediation storm.
 *   - Auditable: every evaluation + firing is appended to an in-memory event
 *     log (ring buffer) that the agent and UI can read.
 */

export interface TriggerFireRecord {
  id: string
  triggerId: string
  triggerName: string
  at: number
  kind: TriggerEntry['kind']
  /** short human description of the matched event. */
  reason: string
  /** the action taken. */
  action: TriggerEntry['action']
  playbookId: string
  /** outcome reported by the runner (ok/error/skipped-reason). */
  outcome?: string
}

export interface TriggerEngineDeps {
  /** run a playbook by id/name; resolves to an outcome string. */
  runPlaybook: (playbookId: string, reason: string) => Promise<string>
  /** propose a MOP change for a playbook; resolves to a change id/string. */
  proposeChange?: (playbookId: string, reason: string) => Promise<string>
  /** now() override for tests. */
  now?: () => number
  /** max retained fire records (default 200). */
  historyLimit?: number
  /** max concurrent firings in flight (default 3). */
  maxConcurrent?: number
  /** onLog callback. */
  onLog?: (line: string) => void
}

const DEFAULT_COOLDOWN_S = 300
const HISTORY_LIMIT_DEFAULT = 200
const MAX_CONCURRENT_DEFAULT = 3

function num(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : undefined
}

export class TriggerEngine {
  private triggers = new Map<string, TriggerEntry>()
  private fires: TriggerFireRecord[] = []
  private inFlight = 0
  private readonly historyLimit: number
  private readonly maxConcurrent: number
  private readonly now: () => number

  constructor(private readonly deps: TriggerEngineDeps) {
    this.historyLimit = deps.historyLimit ?? HISTORY_LIMIT_DEFAULT
    this.maxConcurrent = deps.maxConcurrent ?? MAX_CONCURRENT_DEFAULT
    this.now = deps.now ?? (() => Date.now())
  }

  private log(line: string): void {
    try { this.deps.onLog?.(line) } catch { /* best-effort */ }
  }

  // --- CRUD ---------------------------------------------------------------
  list(): readonly TriggerEntry[] {
    return Array.from(this.triggers.values())
  }

  get(idOrName: string): TriggerEntry | undefined {
    const needle = idOrName.trim().toLowerCase()
    return this.triggers.get(idOrName) ??
      Array.from(this.triggers.values()).find((t) => t.name.trim().toLowerCase() === needle)
  }

  upsert(input: Omit<TriggerEntry, 'id' | 'createdAt' | 'fireCount' | 'lastFiredAt'> & { id?: string }): TriggerEntry {
    const existing = input.id ? this.triggers.get(input.id) : this.get(input.name)
    if (existing) {
      const merged: TriggerEntry = { ...existing, ...input, id: existing.id, createdAt: existing.createdAt }
      this.triggers.set(existing.id, merged)
      return merged
    }
    const entry: TriggerEntry = {
      ...input,
      id: input.id ?? `trg-${randomUUID().slice(0, 8)}`,
      createdAt: this.now(),
      fireCount: 0,
    }
    this.triggers.set(entry.id, entry)
    return entry
  }

  remove(idOrName: string): boolean {
    const t = this.get(idOrName)
    if (!t) return false
    return this.triggers.delete(t.id)
  }

  setEnabled(idOrName: string, enabled: boolean): boolean {
    const t = this.get(idOrName)
    if (!t) return false
    t.enabled = enabled
    return true
  }

  listFires(): readonly TriggerFireRecord[] {
    return this.fires
  }

  // --- Event ingestion ----------------------------------------------------
  /** Feed raw terminal output for a host. */
  handleTerminalData(host: string, data: string): void {
    for (const t of this.triggers.values()) {
      if (!t.enabled || t.kind !== 'pattern') continue
      if (!this.inScope(t, host)) continue
      if (!t.match) continue
      if (this.matchesPattern(t, data)) {
        void this.fire(t, `pattern "${t.match}" seen in ${host} output`)
      }
    }
  }

  /** Feed a monitor snapshot for a host (flat metric map). */
  handleMonitorSnapshot(host: string, metrics: Record<string, unknown>): void {
    for (const t of this.triggers.values()) {
      if (!t.enabled || t.kind !== 'threshold') continue
      if (!this.inScope(t, host)) continue
      if (!t.metric || t.value === undefined || t.op === undefined) continue
      const actual = num(metrics[t.metric])
      if (actual === undefined) continue
      if (this.compare(actual, t.op, t.value)) {
        void this.fire(t, `${t.metric} ${t.op} ${t.value} (actual ${actual}) on ${host}`)
      }
    }
  }

  /** Manually fire any webhook-kind triggers (or test a specific one). */
  fire_webhook(triggerIdOrName?: string, reason?: string): string[] {
    const fired: string[] = []
    for (const t of this.triggers.values()) {
      if (!t.enabled || t.kind !== 'webhook') continue
      if (triggerIdOrName && t.id !== triggerIdOrName && t.name !== triggerIdOrName) continue
      void this.fire(t, reason ?? 'webhook')
      fired.push(t.id)
    }
    return fired
  }

  // --- Matching -----------------------------------------------------------
  private inScope(t: TriggerEntry, host: string): boolean {
    if (!t.scopeHosts || t.scopeHosts.length === 0) return true
    const needle = host.trim().toLowerCase()
    return t.scopeHosts.some((h) => h.trim().toLowerCase() === needle)
  }

  private matchesPattern(t: TriggerEntry, data: string): boolean {
    if (!t.match) return false
    if (t.matchMode === 'regex') {
      try { return new RegExp(t.match, 'm').test(data) } catch { return data.includes(t.match) }
    }
    return data.includes(t.match)
  }

  private compare(actual: number, op: NonNullable<TriggerEntry['op']>, value: number): boolean {
    switch (op) {
      case 'gt': return actual > value
      case 'gte': return actual >= value
      case 'lt': return actual < value
      case 'lte': return actual <= value
      case 'eq': return actual === value
      default: return false
    }
  }

  // --- Firing ---------------------------------------------------------------
  private async fire(t: TriggerEntry, reason: string): Promise<void> {
    const now = this.now()
    const cooldownMs = (t.cooldownSeconds ?? DEFAULT_COOLDOWN_S) * 1000
    if (t.lastFiredAt && now - t.lastFiredAt < cooldownMs) {
      this.log(`[trigger] "${t.name}" matched but is in cooldown — skipped`)
      return
    }
    if (this.inFlight >= this.maxConcurrent) {
      this.log(`[trigger] "${t.name}" matched but concurrency cap (${this.maxConcurrent}) reached — skipped`)
      return
    }
    t.lastFiredAt = now
    t.fireCount = (t.fireCount ?? 0) + 1

    const rec: TriggerFireRecord = {
      id: `fire-${randomUUID().slice(0, 8)}`,
      triggerId: t.id,
      triggerName: t.name,
      at: now,
      kind: t.kind,
      reason,
      action: t.action,
      playbookId: t.playbookId,
    }
    this.fires.unshift(rec)
    if (this.fires.length > this.historyLimit) this.fires.length = this.historyLimit

    this.inFlight += 1
    try {
      if (t.action === 'propose-change' && this.deps.proposeChange) {
        rec.outcome = await this.deps.proposeChange(t.playbookId, reason)
      } else {
        rec.outcome = await this.deps.runPlaybook(t.playbookId, reason)
      }
      this.log(`[trigger] "${t.name}" fired (${reason}) -> ${rec.outcome}`)
    } catch (e) {
      rec.outcome = `error: ${e instanceof Error ? e.message : String(e)}`
      this.log(`[trigger] "${t.name}" failed: ${rec.outcome}`)
    } finally {
      this.inFlight -= 1
    }
  }

  /** Test helper: clear in-memory triggers + fires. */
  clear(): void {
    this.triggers.clear()
    this.fires.length = 0
    this.inFlight = 0
  }
}
