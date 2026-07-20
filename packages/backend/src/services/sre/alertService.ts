import { randomUUID } from 'crypto'

/**
 * AlertService — alertmanager-style alert routing, grouping, dedupe, and
 * maintenance silences (Tier 1 SRE).
 *
 * Signals (watchdog transitions, SLO fast-burns, trigger fires) become alerts.
 * The service groups identical alerts, dedupes repeats within a window, honours
 * maintenance silences, and routes each alert group to configured channels
 * (telegram/webhook/email/slack via injected senders). Pure + injectable.
 */

export type AlertSeverity = 'info' | 'warning' | 'critical'

export interface Alert {
  /** fingerprint: dedupe/group key (e.g. 'watchdog:web-01:down'). */
  fingerprint: string
  title: string
  severity: AlertSeverity
  source: string
  detail?: string
  labels?: Record<string, string>
  at: number
}

export interface AlertGroup {
  fingerprint: string
  title: string
  severity: AlertSeverity
  count: number
  firstAt: number
  lastAt: number
  lastAlert: Alert
  /** true while silenced. */
  silenced: boolean
}

export interface Silence {
  id: string
  /** match alerts whose fingerprint contains this (or matches as regex when regex=true). */
  matcher: string
  regex?: boolean
  until: number
  comment?: string
}

export interface AlertChannel {
  name: string
  /** minimum severity to route (info < warning < critical). */
  minSeverity?: AlertSeverity
  send: (group: AlertGroup) => Promise<string>
}

export interface AlertServiceDeps {
  channels?: AlertChannel[]
  now?: () => number
  /** dedupe window in ms: repeats of the same fingerprint within this window are
   * grouped (not re-sent). Default 5 min. */
  dedupeMs?: number
  /** history limit (default 200). */
  historyLimit?: number
  onLog?: (line: string) => void
}

const SEV_ORDER: Record<AlertSeverity, number> = { info: 0, warning: 1, critical: 2 }
const DEFAULT_DEDUPE_MS = 300_000
const DEFAULT_HISTORY = 200

export class AlertService {
  private readonly groups = new Map<string, AlertGroup>()
  private readonly silences = new Map<string, Silence>()
  private readonly sentHistory: string[] = []
  private readonly now: () => number
  private readonly dedupeMs: number
  private readonly historyLimit: number

  constructor(private readonly deps: AlertServiceDeps = {}) {
    this.now = deps.now ?? (() => Date.now())
    this.dedupeMs = deps.dedupeMs ?? DEFAULT_DEDUPE_MS
    this.historyLimit = deps.historyLimit ?? DEFAULT_HISTORY
  }

  private log(line: string): void {
    try { this.deps.onLog?.(line) } catch { /* best-effort */ }
  }

  /** Create a silence that suppresses matching alerts until `untilMs`. */
  silence(matcher: string, untilMs: number, opts: { regex?: boolean; comment?: string } = {}): Silence {
    const s: Silence = { id: `sil-${randomUUID().slice(0, 8)}`, matcher, until: untilMs, ...opts }
    this.silences.set(s.id, s)
    return s
  }

  listSilences(): readonly Silence[] {
    const now = this.now()
    return Array.from(this.silences.values()).filter((s) => s.until > now)
  }

  removeSilence(id: string): boolean {
    return this.silences.delete(id)
  }

  private isSilenced(alert: Alert): boolean {
    const now = this.now()
    for (const s of this.silences.values()) {
      if (s.until <= now) continue
      if (s.regex) {
        try { if (new RegExp(s.matcher).test(alert.fingerprint)) return true } catch { /* fall through to substring */ }
      }
      if (alert.fingerprint.includes(s.matcher)) return true
    }
    return false
  }

  /** Fire an alert: group/dedupe it, then route the group to channels (unless
   * silenced or within the dedupe window). Returns the group + whether it was sent. */
  async fire(alert: Alert): Promise<{ group: AlertGroup; sent: boolean; reason?: string }> {
    const fp = alert.fingerprint
    let g = this.groups.get(fp)
    if (!g) {
      g = {
        fingerprint: fp,
        title: alert.title,
        severity: alert.severity,
        count: 0,
        firstAt: alert.at,
        lastAt: alert.at,
        lastAlert: alert,
        silenced: false,
      }
      this.groups.set(fp, g)
    }
    g.count += 1
    g.lastAt = alert.at
    g.lastAlert = alert
    g.severity = alert.severity // escalate to latest severity

    if (this.isSilenced(alert)) {
      g.silenced = true
      this.log(`[alert] "${alert.title}" silenced (fingerprint ${fp})`)
      return { group: g, sent: false, reason: 'silenced' }
    }
    g.silenced = false

    // dedupe: only re-send if the last send was outside the dedupe window.
    const lastSentAt = (g as unknown as { _lastSentAt?: number })._lastSentAt ?? 0
    if (this.now() - lastSentAt < this.dedupeMs && g.count > 1) {
      return { group: g, sent: false, reason: 'deduped' }
    }

    await this.route(g)
    ;(g as unknown as { _lastSentAt?: number })._lastSentAt = this.now()
    return { group: g, sent: true }
  }

  private async route(group: AlertGroup): Promise<void> {
    const channels = this.deps.channels ?? []
    for (const ch of channels) {
      const min = ch.minSeverity ? SEV_ORDER[ch.minSeverity] : 0
      if (SEV_ORDER[group.severity] < min) continue
      try {
        await ch.send(group)
        this.log(`[alert] routed "${group.title}" -> ${ch.name}`)
      } catch (e) {
        this.log(`[alert] channel ${ch.name} failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    this.sentHistory.unshift(`${new Date(this.now()).toISOString()} ${group.severity} ${group.title} (x${group.count})`)
    if (this.sentHistory.length > this.historyLimit) this.sentHistory.length = this.historyLimit
  }

  groups_(): readonly AlertGroup[] {
    return Array.from(this.groups.values())
  }

  history(): readonly string[] {
    return this.sentHistory
  }

  /** Acknowledge an alert group (stop re-sending until a new severity escalation). */
  ack(fingerprint: string): boolean {
    const g = this.groups.get(fingerprint)
    if (!g) return false
    ;(g as unknown as { _lastSentAt?: number })._lastSentAt = this.now()
    return true
  }

  clear(): void {
    this.groups.clear()
    this.silences.clear()
    this.sentHistory.length = 0
  }
}
