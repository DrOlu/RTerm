import { z } from 'zod'
import type { ToolExecutionContext } from '../types'
import type { BackendSettings, PlaybookStep } from '../../../types'
import { executePlaybook } from '../../automation/playbookRunner'
import { executeOrchestratedPlaybook } from '../../automation/orchestratedPlaybookRunner'

/** True when a playbook uses Advanced Automation features that need the
 * orchestrated engine (dependsOn DAG, runbook params, idempotent desiredState,
 * captureVar). Linear playbooks keep the proven sequential runner. */
export function playbookNeedsOrchestration(playbook: { steps: PlaybookStep[]; params?: unknown; maxParallelSteps?: number }): boolean {
  if (playbook.maxParallelSteps && playbook.maxParallelSteps > 1) return true
  if (Array.isArray(playbook.params) && playbook.params.length > 0) return true
  return playbook.steps.some((s) =>
    (s.dependsOn !== undefined) || s.desiredState || s.captureVar,
  )
}

/**
 * Playbook agent tools — `manage_playbook` (CRUD) + `run_playbook`
 * (execution). Playbooks are ordered, multi-step workflows (command / saved
 * script / wait steps) that run against a target scope (group, tags, explicit
 * connections, or the local shell). Steps run sequentially per target with a
 * stop-or-continue failure policy; every run is recorded in the in-memory
 * playbook run history and stamped on the entry (lastRunAt/lastRunOk).
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

function noStore(): string {
  return 'Automation store is not available in this runtime (no automation manager wired).'
}

const stepSchema = z.object({
  id: z.string().optional().describe('Optional stable step id (assigned when omitted).'),
  name: z.string().optional().describe('Display name, e.g. "collect show run".'),
  kind: z.enum(['command', 'script', 'wait']),
  command: z.string().optional().describe('Inline command (kind=command).'),
  scriptId: z.string().optional().describe('Saved script id (kind=script; see manage_script).'),
  waitSeconds: z.number().positive().optional().describe('Pause length in seconds (kind=wait).'),
  onError: z.enum(['stop', 'continue']).optional().describe('Per-step failure policy (overrides the playbook default).'),
  validate: z.object({
    command: z.string().optional().describe('Inline check command (mutually exclusive with scriptId).'),
    scriptId: z.string().optional().describe('Saved script used as the check.'),
    expect: z.string().describe('Pattern the check output must contain/match.'),
    expectMode: z.enum(['substring', 'regex']).optional().describe('Pattern interpretation (default substring).'),
  }).optional().describe('Post-step validation: check runs after the step; a mismatch fails the step and triggers rollback.'),
  rollback: z.object({
    kind: z.enum(['command', 'script']),
    command: z.string().optional().describe('Inline undo command (kind=command).'),
    scriptId: z.string().optional().describe('Saved undo script id (kind=script).'),
  }).optional().describe('Undo action executed (reverse step order) when a later step or validation fails.'),
})

export const managePlaybookSchema = z.object({
  action: z.enum(['create', 'update', 'delete', 'list', 'get']),
  id: z.string().optional().describe('Playbook id (update/delete/get).'),
  name: z.string().optional().describe('Playbook name (create/update; also usable as lookup in get).'),
  description: z.string().optional(),
  steps: z.array(stepSchema).optional().describe('Ordered steps (create/update). At least one required.'),
  groupId: z.string().optional().describe('Target scope: run against connections in this group.'),
  tags: z.array(z.string()).optional().describe('Target scope: run against connections with any of these tags.'),
  targets: z.array(z.string()).optional().describe('Target scope: explicit saved-connection names.'),
  onError: z.enum(['stop', 'continue']).optional().describe('Default failure policy for steps (default stop).'),
  requireApproval: z.boolean().optional().describe('MOP mode: only runnable via an approved change record (manage_change plan → approve → run).'),
})

export const runPlaybookSchema = z.object({
  id: z.string().optional().describe('Playbook id to run.'),
  name: z.string().optional().describe('Playbook name to run (when id is not given).'),
  paramValues: z.record(z.string(), z.string()).optional().describe('Run-time values for the playbook\'s declared params (Advanced Automation).'),
})

export async function managePlaybook(
  args: z.infer<typeof managePlaybookSchema>,
  context: ToolExecutionContext,
): Promise<string> {
  const m = context.automationManager
  if (!m) { const msg = noStore(); emit(context, 'manage_playbook', args, msg); return msg }
  const { action } = args

  if (action === 'list') {
    const all = m.listPlaybooks()
    if (!all.length) { const msg = 'No playbooks. Create one with manage_playbook action=create.'; emit(context, 'manage_playbook', args, msg); return msg }
    const body = all.map((p) => {
      const last = p.lastRunAt ? `, last run ${p.lastRunAt} ${p.lastRunOk === true ? 'OK' : p.lastRunOk === false ? 'FAILED' : ''}` : ', never run'
      return `- ${p.name} (id=${p.id}, ${p.steps.length} step(s)${last})`
    }).join('\n')
    const msg = `Playbooks (${all.length}):\n${body}`
    emit(context, 'manage_playbook', args, msg)
    return msg
  }

  if (action === 'get') {
    const key = args.id ?? args.name
    if (!key) { const msg = 'get requires id or name.'; emit(context, 'manage_playbook', args, msg); return msg }
    const p = m.getPlaybook(key)
    if (!p) { const msg = `No playbook "${key}".`; emit(context, 'manage_playbook', args, msg); return msg }
    const steps = p.steps.map((s, i) => {
      const what = s.kind === 'wait' ? `wait ${s.waitSeconds}s` : s.kind === 'script' ? `script ${s.scriptId}` : (s.command ?? '').split('\n')[0]
      const flags = [s.onError ? `onError=${s.onError}` : '', s.validate ? `validate:${s.validate.expectMode ?? 'substring'} "${s.validate.expect}"` : '', s.rollback ? 'rollback defined' : ''].filter(Boolean).join(', ')
      return `  ${i + 1}. [${s.kind}] ${s.name ? `${s.name} — ` : ''}${what}${flags ? ` (${flags})` : ''}`
    }).join('\n')
    const scope = p.groupId ? `group=${p.groupId}` : p.targets?.length ? `targets=${p.targets.join(',')}` : p.tags?.length ? `tags=${p.tags.join(',')}` : 'local shell'
    const msg = `Playbook "${p.name}" (id=${p.id})\nScope: ${scope}\nDefault onError: ${p.onError ?? 'stop'}${p.requireApproval ? '\nMOP mode: requires an approved change record (manage_change) to run' : ''}\nSteps:\n${steps}`
    emit(context, 'manage_playbook', args, msg)
    return msg
  }

  if (action === 'create') {
    if (!args.name || !args.steps?.length) { const msg = 'create requires name + at least one step.'; emit(context, 'manage_playbook', args, msg); return msg }
    try {
      const p = m.createPlaybook({
        name: args.name,
        description: args.description,
        steps: args.steps as PlaybookStep[],
        groupId: args.groupId,
        tags: args.tags,
        targets: args.targets,
        onError: args.onError,
        requireApproval: args.requireApproval,
      })
      const msg = `Created playbook "${p.name}" (id=${p.id}, ${p.steps.length} step(s)). ${p.requireApproval ? 'MOP mode: run it via manage_change (plan → approve → run).' : 'Run it with run_playbook.'}`
      emit(context, 'manage_playbook', args, msg)
      return msg
    } catch (error) {
      const msg = `Could not create playbook: ${error instanceof Error ? error.message : error}`
      emit(context, 'manage_playbook', args, msg)
      return msg
    }
  }

  if (action === 'update') {
    if (!args.id) { const msg = 'update requires id.'; emit(context, 'manage_playbook', args, msg); return msg }
    try {
      const p = m.updatePlaybook({
        id: args.id,
        ...(args.name !== undefined ? { name: args.name } : {}),
        ...(args.description !== undefined ? { description: args.description } : {}),
        ...(args.steps !== undefined ? { steps: args.steps as PlaybookStep[] } : {}),
        ...(args.groupId !== undefined ? { groupId: args.groupId } : {}),
        ...(args.tags !== undefined ? { tags: args.tags } : {}),
        ...(args.targets !== undefined ? { targets: args.targets } : {}),
        ...(args.onError !== undefined ? { onError: args.onError } : {}),
        ...(args.requireApproval !== undefined ? { requireApproval: args.requireApproval } : {}),
      })
      const msg = `Updated playbook "${p.name}" (${p.steps.length} step(s)).`
      emit(context, 'manage_playbook', args, msg)
      return msg
    } catch (error) {
      const msg = `Could not update playbook: ${error instanceof Error ? error.message : error}`
      emit(context, 'manage_playbook', args, msg)
      return msg
    }
  }

  if (action === 'delete') {
    if (!args.id) { const msg = 'delete requires id.'; emit(context, 'manage_playbook', args, msg); return msg }
    const removed = m.deletePlaybook(args.id)
    const msg = removed ? `Deleted playbook ${args.id}.` : `No playbook ${args.id}.`
    emit(context, 'manage_playbook', args, msg)
    return msg
  }

  const msg = `Unknown action "${action as string}".`
  emit(context, 'manage_playbook', args, msg)
  return msg
}

export async function runPlaybook(
  args: z.infer<typeof runPlaybookSchema>,
  context: ToolExecutionContext,
): Promise<string> {
  const m = context.automationManager
  if (!m) { const msg = noStore(); emit(context, 'run_playbook', args, msg); return msg }
  const key = args.id ?? args.name
  if (!key) { const msg = 'run_playbook requires id or name.'; emit(context, 'run_playbook', args, msg); return msg }
  const playbook = m.getPlaybook(key)
  if (!playbook) {
    const msg = `No playbook "${key}". Use manage_playbook action=list to see valid playbooks.`
    emit(context, 'run_playbook', args, msg)
    return msg
  }
  if (playbook.requireApproval) {
    const msg = `Playbook "${playbook.name}" is in MOP mode (requireApproval). Run it through a change record: manage_change action=plan name="${playbook.name}" → approve → run.`
    emit(context, 'run_playbook', args, msg)
    return msg
  }

  // Build a settings snapshot for target resolution from the context's
  // connection lists (refreshed on every settings change).
  const settings = {
    connections: {
      ssh: context.savedSshConnections ?? [],
      winrm: context.savedWinrmConnections ?? [],
      serial: context.savedSerialConnections ?? [],
      proxies: context.savedProxies ?? [],
      tunnels: context.savedTunnels ?? [],
    },
  } as unknown as BackendSettings

  let record
  try {
    if (playbookNeedsOrchestration(playbook)) {
      record = await executeOrchestratedPlaybook(
        {
          terminalService: context.terminalService,
          automationManager: m,
          getSettings: () => settings,
          onLog: () => {},
          paramValues: args.paramValues ?? {},
        },
        playbook,
      )
    } else {
      record = await executePlaybook(
        {
          terminalService: context.terminalService,
          automationManager: m,
          getSettings: () => settings,
          onLog: () => {},
        },
        playbook,
      )
    }
  } catch (error) {
    const msg = `Playbook "${playbook.name}" could not run: ${error instanceof Error ? error.message : error}`
    emit(context, 'run_playbook', args, msg)
    return msg
  }

  const lines: string[] = []
  for (const t of record.targets) {
    lines.push(`Target ${t.target}: ${t.ok ? 'OK' : 'FAILED'}${t.error ? ` (${t.error})` : ''}`)
    for (const s of t.steps) {
      const label = s.name ?? `${s.kind} step ${s.stepIndex + 1}`
      const status = s.ok ? 'ok' : `FAILED${s.continuedAfterFailure ? ' (continued)' : ''}${s.error ? `: ${s.error}` : ''}`
      lines.push(`  ${s.stepIndex + 1}. ${label} — ${status}`)
    }
  }
  const okTargets = record.targets.filter((t) => t.ok).length
  const msg = `Playbook "${record.playbookName}" ${record.ok ? 'completed OK' : 'FAILED'} (runId=${record.runId}, ${okTargets}/${record.targets.length} target(s) ok):\n${lines.join('\n')}`
  emit(context, 'run_playbook', args, msg)
  return msg
}
