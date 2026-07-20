import { z } from 'zod'
import type { ToolExecutionContext } from '../types'
import type { TriggerEntry } from '../../../types'
import { randomUUID } from 'crypto'

/**
 * Trigger agent tools — manage event-driven automation triggers (Advanced
 * Automation v1.9.1). A trigger watches terminal output patterns, monitor
 * thresholds, or webhook events and fires a playbook (or proposes a MOP change)
 * on match — with cooldown + concurrency caps so a noisy signal can't storm.
 */

function emit(context: ToolExecutionContext, name: string, input: unknown, output: string): void {
  context.sendEvent(context.sessionId, {
    messageId: context.messageId,
    type: 'tool_call',
    toolName: name,
    input: typeof input === 'string' ? input : JSON.stringify(input),
    output,
  })
}

export const manageTriggerSchema = z.object({
  action: z.enum(['create', 'update', 'delete', 'list', 'enable', 'disable', 'fires']),
  id: z.string().optional().describe('Trigger id (update/delete/enable/disable).'),
  name: z.string().optional().describe('Trigger name (create/update, or lookup).'),
  kind: z.enum(['pattern', 'threshold', 'webhook', 'schedule']).optional(),
  match: z.string().optional().describe('pattern kind: text/regex to match.'),
  matchMode: z.enum(['substring', 'regex']).optional(),
  metric: z.string().optional().describe('threshold kind: metric name (e.g. cpuUsagePercent).'),
  op: z.enum(['gt', 'gte', 'lt', 'lte', 'eq']).optional(),
  value: z.number().optional().describe('threshold kind: numeric threshold.'),
  scopeHosts: z.array(z.string()).optional().describe('only react to these hosts (empty = all).'),
  actionType: z.enum(['run-playbook', 'propose-change']).optional().describe('what to do on match.'),
  playbookId: z.string().optional().describe('playbook id or name to run/propose.'),
  cooldownSeconds: z.number().optional().describe('seconds between firings (default 300).'),
  limit: z.number().optional().describe('fires action: max records (default 20).'),
})

export async function manageTrigger(
  args: z.infer<typeof manageTriggerSchema>,
  context: ToolExecutionContext,
): Promise<string> {
  const m = context.automationManager as any
  if (!m || typeof m.listTriggers !== 'function') {
    const msg = 'Automation store with trigger support is not available in this runtime.'
    emit(context, 'manage_trigger', args, msg); return msg
  }
  const engine = (context as any).triggerEngine
  const { action } = args

  if (action === 'list') {
    const all = m.listTriggers() as readonly TriggerEntry[]
    if (!all.length) { const msg = 'No triggers configured.'; emit(context, 'manage_trigger', args, msg); return msg }
    const body = all.map((t) => {
      const cond = t.kind === 'pattern' ? `"${t.match}"` : t.kind === 'threshold' ? `${t.metric} ${t.op} ${t.value}` : t.kind
      return `  ${t.enabled ? '●' : '○'} ${t.name} [${t.kind} ${cond}] → ${t.action} ${t.playbookId}${t.scopeHosts?.length ? ` @${t.scopeHosts.join(',')}` : ''}${t.fireCount ? ` (fired ${t.fireCount}x)` : ''}`
    }).join('\n')
    const msg = `Triggers (${all.length}):\n${body}`
    emit(context, 'manage_trigger', args, msg); return msg
  }

  if (action === 'fires') {
    const fires = engine?.listFires?.() ?? []
    if (!fires.length) { const msg = 'No trigger firings recorded yet.'; emit(context, 'manage_trigger', args, msg); return msg }
    const limit = args.limit ?? 20
    const body = fires.slice(0, limit).map((f: any) =>
      `  [${new Date(f.at).toISOString()}] ${f.triggerName} (${f.kind}): ${f.reason} → ${f.action} ${f.playbookId}${f.outcome ? ` — ${f.outcome}` : ''}`
    ).join('\n')
    const msg = `Recent trigger firings (${Math.min(limit, fires.length)} of ${fires.length}):\n${body}`
    emit(context, 'manage_trigger', args, msg); return msg
  }

  if (action === 'create') {
    if (!args.name) { const msg = 'create requires a name.'; emit(context, 'manage_trigger', args, msg); return msg }
    if (!args.kind) { const msg = 'create requires a kind (pattern|threshold|webhook|schedule).'; emit(context, 'manage_trigger', args, msg); return msg }
    if (!args.playbookId) { const msg = 'create requires playbookId.'; emit(context, 'manage_trigger', args, msg); return msg }
    const entry: TriggerEntry = {
      id: `trg-${randomUUID().slice(0, 8)}`,
      name: args.name.trim(),
      enabled: true,
      kind: args.kind,
      ...(args.match !== undefined ? { match: args.match } : {}),
      ...(args.matchMode ? { matchMode: args.matchMode } : {}),
      ...(args.metric !== undefined ? { metric: args.metric } : {}),
      ...(args.op ? { op: args.op } : {}),
      ...(args.value !== undefined ? { value: args.value } : {}),
      ...(args.scopeHosts ? { scopeHosts: args.scopeHosts } : {}),
      action: args.actionType ?? 'run-playbook',
      playbookId: args.playbookId,
      ...(args.cooldownSeconds !== undefined ? { cooldownSeconds: args.cooldownSeconds } : {}),
      createdAt: Date.now(),
      fireCount: 0,
    }
    m.upsertTrigger(entry)
    const msg = `Created trigger "${entry.name}" (${entry.id}) [${entry.kind}] → ${entry.action} ${entry.playbookId}.`
    emit(context, 'manage_trigger', args, msg); return msg
  }

  if (action === 'update') {
    const key = args.id ?? args.name
    if (!key) { const msg = 'update requires id or name.'; emit(context, 'manage_trigger', args, msg); return msg }
    const existing = (m.listTriggers() as readonly TriggerEntry[]).find((t) => t.id === key || t.name.trim().toLowerCase() === key.trim().toLowerCase())
    if (!existing) { const msg = `No trigger "${key}".`; emit(context, 'manage_trigger', args, msg); return msg }
    const merged: TriggerEntry = {
      ...existing,
      ...(args.name !== undefined ? { name: args.name.trim() } : {}),
      ...(args.kind !== undefined ? { kind: args.kind } : {}),
      ...(args.match !== undefined ? { match: args.match } : {}),
      ...(args.matchMode !== undefined ? { matchMode: args.matchMode } : {}),
      ...(args.metric !== undefined ? { metric: args.metric } : {}),
      ...(args.op !== undefined ? { op: args.op } : {}),
      ...(args.value !== undefined ? { value: args.value } : {}),
      ...(args.scopeHosts !== undefined ? { scopeHosts: args.scopeHosts } : {}),
      ...(args.actionType !== undefined ? { action: args.actionType } : {}),
      ...(args.playbookId !== undefined ? { playbookId: args.playbookId } : {}),
      ...(args.cooldownSeconds !== undefined ? { cooldownSeconds: args.cooldownSeconds } : {}),
    }
    m.upsertTrigger(merged)
    const msg = `Updated trigger "${merged.name}" (${merged.id}).`
    emit(context, 'manage_trigger', args, msg); return msg
  }

  if (action === 'delete') {
    const key = args.id ?? args.name
    if (!key) { const msg = 'delete requires id or name.'; emit(context, 'manage_trigger', args, msg); return msg }
    const ok = m.deleteTrigger(key)
    const msg = ok ? `Deleted trigger "${key}".` : `No trigger "${key}".`
    emit(context, 'manage_trigger', args, msg); return msg
  }

  if (action === 'enable' || action === 'disable') {
    const key = args.id ?? args.name
    if (!key) { const msg = `${action} requires id or name.`; emit(context, 'manage_trigger', args, msg); return msg }
    const ok = m.setTriggerEnabled(key, action === 'enable')
    const msg = ok ? `Trigger "${key}" ${action}d.` : `No trigger "${key}".`
    emit(context, 'manage_trigger', args, msg); return msg
  }

  const msg = `Unknown action "${action}".`
  emit(context, 'manage_trigger', args, msg); return msg
}
