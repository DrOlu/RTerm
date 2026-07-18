import { z } from 'zod'
import type { ToolExecutionContext } from '../types'
import type { BackendSettings } from '../../../types'
import { executePlaybook, type PlaybookRunRecord } from '../../automation/playbookRunner'
import { resolveScheduledTaskTargets } from '../../automation/scheduledTaskRunner'
import type { ChangeStatus } from '../../changeLedger'

/**
 * Change-management (MOP) agent tool — `manage_change` drives the full
 * lifecycle of a change record: plan (resolve targets + snapshot, status
 * planned) → approve (operator sign-off) → run (execute the playbook with
 * validation + automatic rollback, recording every event in the durable
 * change ledger) → status/list (audit). Every run leaves a complete,
 * queryable trail: what was planned, who approved, what executed, what
 * validation saw, and whether rollback completed.
 */

function emit(context: ToolExecutionContext, toolName: string, input: unknown, output: string): void {
  context.sendEvent(context.sessionId, {
    messageId: context.messageId,
    type: 'tool_call',
    toolName,
    input: typeof input === 'string' ? input : JSON.stringify(input),
    output,
  })
}

export const manageChangeSchema = z.object({
  action: z.enum(['plan', 'approve', 'run', 'status', 'list']),
  playbookId: z.string().optional().describe('Playbook id (plan).'),
  name: z.string().optional().describe('Playbook name (plan, when playbookId is not given).'),
  changeId: z.string().optional().describe('Change id (approve/run/status).'),
  approvedBy: z.string().optional().describe('Approver name/handle recorded at approve time.'),
  status: z.enum(['planned', 'approved', 'executing', 'committed', 'rolled_back', 'failed', 'aborted']).optional().describe('Filter (list).'),
  limit: z.number().int().positive().max(500).optional().describe('Max rows (list, default 20).'),
})

function deriveFinalStatus(record: PlaybookRunRecord): ChangeStatus {
  if (record.ok) return 'committed'
  const failed = record.targets.filter((t) => !t.ok)
  const allUndoneCleanly = failed.length > 0 && failed.every((t) => t.rolledBack === true && t.rollbackOk !== false)
  return allUndoneCleanly ? 'rolled_back' : 'failed'
}

function settingsFromContext(context: ToolExecutionContext): BackendSettings {
  return {
    connections: {
      ssh: context.savedSshConnections ?? [],
      winrm: context.savedWinrmConnections ?? [],
      serial: context.savedSerialConnections ?? [],
      proxies: context.savedProxies ?? [],
      tunnels: context.savedTunnels ?? [],
    },
  } as unknown as BackendSettings
}

export async function manageChange(
  args: z.infer<typeof manageChangeSchema>,
  context: ToolExecutionContext,
): Promise<string> {
  const m = context.automationManager
  const ledger = context.changeLedger
  if (!m) { const msg = 'Automation store is not available in this runtime.'; emit(context, 'manage_change', args, msg); return msg }
  if (!ledger) { const msg = 'Change ledger is not available in this runtime.'; emit(context, 'manage_change', args, msg); return msg }
  const { action } = args

  if (action === 'plan') {
    const key = args.playbookId ?? args.name
    if (!key) { const msg = 'plan requires playbookId or name.'; emit(context, 'manage_change', args, msg); return msg }
    const playbook = m.getPlaybook(key)
    if (!playbook) { const msg = `No playbook "${key}".`; emit(context, 'manage_change', args, msg); return msg }
    const settings = settingsFromContext(context)
    const targets = resolveScheduledTaskTargets(
      { groupId: playbook.groupId, tags: playbook.tags, targets: playbook.targets },
      settings,
    )
    const changeId = `chg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const snapshot = JSON.stringify(targets.length ? targets.map((t) => `${t.kind}://${t.name}`) : ['local'])
    ledger.createChange({ changeId, playbookId: playbook.id, playbookName: playbook.name, targetsSnapshot: snapshot })
    const steps = playbook.steps.map((s, i) => {
      const flags = [s.validate ? 'validated' : '', s.rollback ? 'rollback' : ''].filter(Boolean).join(', ')
      return `  ${i + 1}. [${s.kind}] ${s.name ?? s.kind}${flags ? ` (${flags})` : ''}`
    }).join('\n')
    const msg = `Planned change ${changeId} for playbook "${playbook.name}" (status=planned).\nTargets (${targets.length || 1}): ${targets.length ? targets.map((t) => t.name).join(', ') : 'local shell'}\nSteps:\n${steps}\nNext: manage_change action=approve changeId=${changeId}, then action=run.`
    emit(context, 'manage_change', args, msg)
    return msg
  }

  if (action === 'approve') {
    if (!args.changeId) { const msg = 'approve requires changeId.'; emit(context, 'manage_change', args, msg); return msg }
    const existing = ledger.getChange(args.changeId)
    if (!existing) { const msg = `No change "${args.changeId}".`; emit(context, 'manage_change', args, msg); return msg }
    if (existing.change.status !== 'planned') {
      const msg = `Change ${args.changeId} is ${existing.change.status} — only planned changes can be approved.`
      emit(context, 'manage_change', args, msg)
      return msg
    }
    ledger.approveChange(args.changeId, args.approvedBy)
    const msg = `Change ${args.changeId} approved${args.approvedBy ? ` by ${args.approvedBy}` : ''}. Execute with manage_change action=run changeId=${args.changeId}.`
    emit(context, 'manage_change', args, msg)
    return msg
  }

  if (action === 'run') {
    if (!args.changeId) { const msg = 'run requires changeId.'; emit(context, 'manage_change', args, msg); return msg }
    const existing = ledger.getChange(args.changeId)
    if (!existing) { const msg = `No change "${args.changeId}". Plan one first with manage_change action=plan.`; emit(context, 'manage_change', args, msg); return msg }
    if (existing.change.status !== 'approved') {
      const msg = `Change ${args.changeId} is ${existing.change.status} — it must be approved before execution (manage_change action=approve).`
      emit(context, 'manage_change', args, msg)
      return msg
    }
    const playbook = m.getPlaybook(existing.change.playbookId)
    if (!playbook) {
      ledger.finishChange(args.changeId, 'failed', 'playbook no longer exists')
      const msg = `Playbook ${existing.change.playbookId} no longer exists; change marked failed.`
      emit(context, 'manage_change', args, msg)
      return msg
    }
    if (!ledger.markExecuting(args.changeId)) {
      const msg = `Change ${args.changeId} could not transition to executing (status=${existing.change.status}).`
      emit(context, 'manage_change', args, msg)
      return msg
    }
    const settings = settingsFromContext(context)
    let record: PlaybookRunRecord
    try {
      record = await executePlaybook(
        {
          terminalService: context.terminalService,
          automationManager: m,
          getSettings: () => settings,
          onLog: () => {},
          changeLedger: ledger,
          changeId: args.changeId,
        },
        playbook,
      )
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      ledger.finishChange(args.changeId, 'failed', errMsg)
      const msg = `Change ${args.changeId} failed to execute: ${errMsg}`
      emit(context, 'manage_change', args, msg)
      return msg
    }
    const finalStatus = deriveFinalStatus(record)
    const rollbackNote = finalStatus === 'rolled_back'
      ? ' — all affected targets were automatically rolled back in reverse step order'
      : finalStatus === 'failed'
        ? ' — check change_steps for rollback failures'
        : ''
    ledger.finishChange(args.changeId, finalStatus, record.ok ? undefined : `${record.targets.filter((t) => !t.ok).length} target(s) failed${rollbackNote}`, record.runId)
    const lines: string[] = []
    for (const t of record.targets) {
      lines.push(`Target ${t.target}: ${t.ok ? 'OK' : 'FAILED'}${t.rolledBack ? ` (rolled back${t.rollbackOk === false ? ' WITH FAILURES' : ''})` : ''}${t.error ? ` — ${t.error}` : ''}`)
      for (const s of t.steps) {
        const bits = [s.ok ? 'ok' : `FAILED${s.error ? `: ${s.error}` : ''}`]
        if (s.validation) bits.push(`validation=${s.validation.ok ? 'pass' : 'FAIL'}`)
        if (s.rolledBack) bits.push(`rolled back${s.rollbackError ? ` (${s.rollbackError})` : ''}`)
        lines.push(`  ${s.stepIndex + 1}. ${s.name ?? s.kind} — ${bits.join(', ')}`)
      }
    }
    const msg = `Change ${args.changeId} finished with status=${finalStatus} (runId=${record.runId}).\n${lines.join('\n')}`
    emit(context, 'manage_change', args, msg)
    return msg
  }

  if (action === 'status') {
    if (!args.changeId) { const msg = 'status requires changeId.'; emit(context, 'manage_change', args, msg); return msg }
    const got = ledger.getChange(args.changeId)
    if (!got) { const msg = `No change "${args.changeId}".`; emit(context, 'manage_change', args, msg); return msg }
    const { change, steps } = got
    const head = `Change ${change.changeId} — playbook "${change.playbookName}" — status=${change.status}`
    const meta = [
      `created ${new Date(change.createdAt).toISOString()}`,
      change.approvedAt ? `approved ${new Date(change.approvedAt).toISOString()}${change.approvedBy ? ` by ${change.approvedBy}` : ''}` : 'not approved',
      change.startedAt ? `started ${new Date(change.startedAt).toISOString()}` : '',
      change.endedAt ? `ended ${new Date(change.endedAt).toISOString()}` : '',
      change.error ? `error: ${change.error}` : '',
      change.runId ? `runId: ${change.runId}` : '',
    ].filter(Boolean).join('; ')
    const body = steps.length
      ? steps.map((s) => `  [${s.phase}] ${s.target} step ${s.stepIndex + 1}${s.stepName ? ` (${s.stepName})` : ''}: ${s.ok ? 'ok' : 'FAILED'}${s.detail ? ` — ${s.detail.slice(0, 200)}` : ''}`).join('\n')
      : '  (no step events recorded yet)'
    const msg = `${head}\n${meta}\nTargets: ${change.targetsSnapshot ?? 'n/a'}\nEvents:\n${body}`
    emit(context, 'manage_change', args, msg)
    return msg
  }

  if (action === 'list') {
    const rows = ledger.listChanges({ status: args.status, limit: args.limit ?? 20 })
    if (!rows.length) { const msg = 'No changes recorded yet. Plan one with manage_change action=plan.'; emit(context, 'manage_change', args, msg); return msg }
    const body = rows.map((c) =>
      `- ${c.changeId} [${c.status}] "${c.playbookName}" created ${new Date(c.createdAt).toISOString()}${c.approvedBy ? `, approved by ${c.approvedBy}` : ''}${c.error ? `, ${c.error.slice(0, 120)}` : ''}`,
    ).join('\n')
    const msg = `Changes (${rows.length}):\n${body}`
    emit(context, 'manage_change', args, msg)
    return msg
  }

  const msg = `Unknown action "${action as string}".`
  emit(context, 'manage_change', args, msg)
  return msg
}
