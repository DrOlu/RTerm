import type { ResourceMonitorService } from '../ResourceMonitorService'
import type { TerminalService } from '../TerminalService'

/**
 * monitorStatusService — diagnostic tool for the ResourceMonitorService.
 *
 * Reports exactly why stats aren't displaying for each terminal: whether the
 * publisher is wired, whether a monitor session exists, whether collection is
 * stuck (inFlight), whether the terminal is connected, whether the platform is
 * detected, and when the last collection ran. Makes debugging the "stats don't
 * display" issue trivial.
 *
 * Pure + injectable: the ResourceMonitorService and TerminalService are injected.
 */

export interface MonitorStatusEntry {
  terminalId: string
  /** whether the terminal exists and is connected. */
  connected: boolean
  /** the terminal's detected platform (linux/darwin/windows/unknown). */
  platform: string
  /** whether the ResourceMonitorService has a session for this terminal. */
  hasSession: boolean
  /** whether a collection is currently in flight (stuck if true for a long time). */
  inFlight: boolean
  /** the last collection timestamp (0 if never). */
  lastCollectAt: number
  /** how long ago the last collection ran (ms). */
  lastCollectAgoMs: number
  /** the diagnosis: why stats aren't displaying. */
  diagnosis: string
}

export interface MonitorStatusReport {
  /** whether the ResourceMonitorService's publisher is wired (required for broadcasting). */
  publisherWired: boolean
  /** the number of terminals being monitored. */
  terminalCount: number
  /** per-terminal status entries. */
  entries: MonitorStatusEntry[]
  /** summary of issues found. */
  issues: string[]
}

export class MonitorStatusService {
  constructor(
    private readonly monitor: ResourceMonitorService,
    private readonly terminalService: TerminalService,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Build the full monitor status report. */
  report(): MonitorStatusReport {
    const publisherWired = (this.monitor as unknown as { publisher?: unknown }).publisher !== null
    const entries: MonitorStatusEntry[] = []
    const issues: string[] = []

    // Get all terminals from the TerminalService.
    const terminals = this.terminalService.getDisplayTerminals()
    const now = this.now()

    for (const terminal of terminals) {
      const terminalId = terminal.id
      const connected = terminal.runtimeState === 'ready'
      const platform = terminal.remoteOs ?? terminal.type ?? 'unknown'

      // Check the monitor session.
      const sessions = (this.monitor as unknown as { sessions?: Map<string, { inFlight?: boolean; lastCollectAt?: number }> }).sessions
      const session = sessions?.get(terminalId)
      const hasSession = session !== undefined
      const inFlight = session?.inFlight === true
      const lastCollectAt = session?.lastCollectAt ?? 0
      const lastCollectAgoMs = lastCollectAt > 0 ? now - lastCollectAt : -1

      // Diagnose.
      let diagnosis = 'ok'
      if (!connected) {
        diagnosis = 'terminal_not_connected'
      } else if (!hasSession) {
        diagnosis = 'no_monitor_session'
      } else if (inFlight) {
        diagnosis = 'collection_stuck_in_flight'
      } else if (lastCollectAt === 0) {
        diagnosis = 'never_collected'
      } else if (lastCollectAgoMs > 30000) {
        diagnosis = `stale_collection (${Math.round(lastCollectAgoMs / 1000)}s ago)`
      }

      entries.push({
        terminalId,
        connected,
        platform,
        hasSession,
        inFlight,
        lastCollectAt,
        lastCollectAgoMs,
        diagnosis,
      })

      if (diagnosis !== 'ok') {
        issues.push(`${terminalId}: ${diagnosis}`)
      }
    }

    // Top-level issues.
    if (!publisherWired) {
      issues.unshift('publisher_not_wired — createObservability may not have been called')
    }
    if (entries.length === 0) {
      issues.push('no_terminals — no terminals connected')
    }

    return {
      publisherWired,
      terminalCount: entries.length,
      entries,
      issues,
    }
  }

  /** Build a compact summary string for the agent. */
  summary(): string {
    const r = this.report()
    const parts: string[] = []
    parts.push(`publisher=${r.publisherWired ? 'wired' : 'NOT WIRED'}`)
    parts.push(`terminals=${r.terminalCount}`)
    if (r.issues.length > 0) {
      parts.push(`issues=${r.issues.length}:`)
      for (const issue of r.issues) {
        parts.push(`  - ${issue}`)
      }
    } else {
      parts.push('all terminals collecting normally')
    }
    return parts.join('\n')
  }
}
