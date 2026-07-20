import { TriggerEngine } from './triggerEngine'
import type { AutomationManager } from './AutomationManager'
import type { TerminalService } from '../TerminalService'
import type { ResourceMonitorService } from '../ResourceMonitorService'
import type { TriggerEntry } from '../../types'

/**
 * Wire a TriggerEngine into the live runtime: load persisted triggers from the
 * automation store, feed it terminal output + monitor snapshots, and persist
 * CRUD changes back. Returns the engine (also used by the agent's
 * manage_trigger tool via context.triggerEngine).
 *
 * The engine is fed from the same raw event channel that drives the UI/gateway,
 * so pattern triggers see the exact bytes the operator sees, and threshold
 * triggers see the same monitor metrics the Monitor panel shows.
 */
export interface TriggerRuntimeDeps {
  automationManager: AutomationManager
  terminalService: TerminalService
  monitorService?: ResourceMonitorService | null
  runPlaybook: (playbookId: string, reason: string) => Promise<string>
  proposeChange?: (playbookId: string, reason: string) => Promise<string>
  onLog?: (line: string) => void
}

export function createTriggerRuntime(deps: TriggerRuntimeDeps): TriggerEngine {
  const engine = new TriggerEngine({
    runPlaybook: deps.runPlaybook,
    proposeChange: deps.proposeChange,
    onLog: deps.onLog,
  })

  // Load persisted triggers.
  for (const t of deps.automationManager.listTriggers() as readonly TriggerEntry[]) {
    engine.upsert(t)
  }

  // Feed terminal output -> pattern triggers.
  const ts = deps.terminalService as unknown as {
    setRawEventPublisher?: (pub: (channel: string, data: unknown) => void) => void
  }
  const prev = (ts as any).rawEventPublisher as ((channel: string, data: unknown) => void) | null | undefined
  ts.setRawEventPublisher?.((channel: string, data: unknown) => {
    try { prev?.(channel, data) } catch { /* preserve existing behaviour */ }
    if (channel === 'terminal:data' && data && typeof data === 'object') {
      const d = data as { terminalId?: string; data?: string }
      if (typeof d.data === 'string' && d.terminalId) {
        engine.handleTerminalData(String(d.terminalId), d.data)
      }
    }
  })

  // Feed monitor snapshots -> threshold triggers.
  const ms = deps.monitorService as unknown as {
    setPublisher?: (pub: (channel: string, data: unknown) => void) => void
  } | null | undefined
  if (ms && typeof ms.setPublisher === 'function') {
    const prevPub = (ms as any).publisher as ((channel: string, data: unknown) => void) | null | undefined
    ms.setPublisher((channel: string, data: unknown) => {
      try { prevPub?.(channel, data) } catch { /* preserve existing behaviour */ }
      if (channel === 'monitor:snapshot' && data && typeof data === 'object') {
        const d = data as Record<string, unknown> & { terminalId?: string }
        const host = d.terminalId ? String(d.terminalId) : 'local'
        engine.handleMonitorSnapshot(host, d as Record<string, unknown>)
      }
    })
  }

  return engine
}
