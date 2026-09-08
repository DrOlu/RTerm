import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import type { ToolExecutionContext } from '../types'
import { connectionIdentity } from '../../learning/compoundingKnowledge'

function emit(context: ToolExecutionContext, toolName: string, input: unknown, output: string): void {
  context.sendEvent(context.sessionId, {
    messageId: context.messageId,
    type: 'tool_call',
    toolName,
    input: typeof input === 'string' ? input : JSON.stringify(input),
    output,
  })
}

export const opsExperimentSchema = z.object({
  hypothesis: z.string().min(1).describe('What you think is true, e.g. "SMB IPC$ is blocked (NetUseAdd 64)".'),
  probe: z.string().min(1).describe('One cheap command that would confirm or reject the hypothesis.'),
  tag: z
    .enum(['ad-join', 'ad-promo', 'smb', 'aws-sg', 'disk', 'windows-feature', 'psrp', 'dns', 'other'])
    .describe('Probe family. Gated mutations require a matching tag in this session (e.g. Add-Computer needs ad-join).'),
  expect: z.string().optional().describe('Optional substring the probe output must contain to count as ok.'),
  tabIdOrName: z.string().optional().describe('Optional tab to run the probe on. If omitted, the experiment is recorded as a plan only.'),
})

export const manageGoalSchema = z.object({
  action: z.enum(['upsert', 'list', 'done', 'abandon']).describe('upsert a goal, list session goals, mark done, or abandon.'),
  id: z.string().optional().describe('Goal id (upsert/done/abandon). Generated if omitted on upsert.'),
  text: z.string().optional().describe('Goal text (upsert).'),
  status: z.enum(['open', 'blocked', 'done', 'abandoned']).optional(),
  blockedBy: z.string().optional(),
  nextProbe: z.string().optional(),
})

export const estateFactsSchema = z.object({
  action: z.enum(['upsert', 'list']).describe('upsert a fact for a connection identity, or list the estate snapshot.'),
  name: z.string().optional().describe('Saved connection name (preferred identity).'),
  host: z.string().optional(),
  role: z.string().optional().describe('dc | member | workgroup | other'),
  domain: z.string().optional(),
  transport: z.string().optional(),
  auth: z.string().optional(),
  facts: z.record(z.unknown()).optional(),
})

export async function opsExperiment(
  args: z.infer<typeof opsExperimentSchema>,
  context: ToolExecutionContext,
): Promise<string> {
  const store = context.compoundingStore
  if (!store) {
    const msg = 'Compounding store is not wired in this runtime.'
    emit(context, 'ops_experiment', args, msg)
    return msg
  }
  store.recordProbe(context.sessionId, args.tag, args.hypothesis, args.probe, false)
  const msg =
    `Recorded experiment tag=${args.tag}\n` +
    `hypothesis: ${args.hypothesis}\n` +
    `probe: ${args.probe}\n` +
    (args.expect ? `expect: ${args.expect}\n` : '') +
    (args.tabIdOrName
      ? `Run the probe on tab "${args.tabIdOrName}" with exec_command, then treat a match of expect as confirmation. Do not retry the original mutation until the probe has been run.`
      : `Run the probe next. Gated mutations that require tag "${args.tag}" are now allowed in this session only AFTER you actually run the probe command.`)
  emit(context, 'ops_experiment', args, msg)
  return msg
}

export async function manageGoal(
  args: z.infer<typeof manageGoalSchema>,
  context: ToolExecutionContext,
): Promise<string> {
  const store = context.compoundingStore
  if (!store) {
    const msg = 'Compounding store is not wired in this runtime.'
    emit(context, 'manage_goal', args, msg)
    return msg
  }
  if (args.action === 'list') {
    const goals = store.listGoals(context.sessionId)
    const msg = goals.length
      ? goals.map((g) => `- ${g.id} [${g.status}] ${g.text}${g.blockedBy ? ` blocked_by=${g.blockedBy}` : ''}`).join('\n')
      : 'No goals in this session.'
    emit(context, 'manage_goal', args, msg)
    return msg
  }
  const id = args.id || `goal-${randomUUID().slice(0, 8)}`
  if (args.action === 'done' || args.action === 'abandon') {
    const existing = store.listGoals(context.sessionId).find((g) => g.id === id)
    store.upsertGoal({
      id,
      sessionId: context.sessionId,
      text: existing?.text || args.text || id,
      status: args.action === 'done' ? 'done' : 'abandoned',
    })
    const msg = `Goal ${id} marked ${args.action}.`
    emit(context, 'manage_goal', args, msg)
    return msg
  }
  if (!args.text) {
    const msg = 'upsert requires text'
    emit(context, 'manage_goal', args, msg)
    return msg
  }
  store.upsertGoal({
    id,
    sessionId: context.sessionId,
    text: args.text,
    status: args.status || 'open',
    blockedBy: args.blockedBy,
    nextProbe: args.nextProbe,
  })
  const msg = `Goal ${id} [${args.status || 'open'}] ${args.text}`
  emit(context, 'manage_goal', args, msg)
  return msg
}

export async function estateFacts(
  args: z.infer<typeof estateFactsSchema>,
  context: ToolExecutionContext,
): Promise<string> {
  const store = context.compoundingStore
  if (!store) {
    const msg = 'Compounding store is not wired in this runtime.'
    emit(context, 'estate_facts', args, msg)
    return msg
  }
  if (args.action === 'list') {
    const facts = store.listEstateFacts()
    const msg = facts.length
      ? facts
          .map((f) => {
            const bits = [f.identity, f.role, f.domain, [f.transport, f.auth].filter(Boolean).join('/')].filter(Boolean)
            return `- ${bits.join(' · ')}`
          })
          .join('\n')
      : 'No estate facts recorded yet. Upsert after collect_facts / AD probes.'
    emit(context, 'estate_facts', args, msg)
    return msg
  }
  const identity = connectionIdentity({
    name: args.name,
    host: args.host,
    transport: args.transport,
    auth: args.auth,
    domain: args.domain,
  })
  store.upsertEstateFact({
    identity,
    host: args.host,
    role: args.role,
    domain: args.domain,
    transport: args.transport,
    auth: args.auth,
    facts: args.facts,
  })
  const msg = `Upserted estate fact identity=${identity}`
  emit(context, 'estate_facts', args, msg)
  return msg
}

export const OPS_EXPERIMENT_DESCRIPTION =
  'Record a named hypothesis + cheap probe BEFORE a destructive mutation (Add-Computer, Install-ADDSForest, djoin /provision, Set-SmbServerConfiguration, SG ingress). ' +
  'Gated commands refuse to run in this session until ops_experiment has been called with the matching tag (ad-join, ad-promo, smb, aws-sg, …). ' +
  'If the probe fails, do NOT retry the original mutation — pick the INSTEAD from compounding lessons (e.g. djoin instead of Add-Computer).'

export const MANAGE_GOAL_DESCRIPTION =
  'Persistent operator intent for this chat session: upsert/list/done/abandon goals so a multi-step job (join server-2, wait for reboot) survives tool loops. ' +
  'Call upsert when the user states a job; list at the start of a turn if you might have forgotten.'

export const ESTATE_FACTS_DESCRIPTION =
  'Queryable snapshot of THIS estate keyed by connection NAME not IP ' +
  '(CORP-DC1 psrp+negotiate is not neuralos-win1 psrp+basic even on the same host). ' +
  'Upsert after collect_facts / Get-ADDomain; list to see dc vs member vs workgroup.'
