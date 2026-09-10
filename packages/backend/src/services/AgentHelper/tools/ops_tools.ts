/**
 * ops_tools — agent tools for the v3.8.1 operator capabilities.
 *
 * Every handler delegates to the SAME OpsService the gateway `ops:*` methods
 * use, so the agent and an RPC client can never drift.
 */
import { z } from 'zod'
import type { ToolExecutionContext } from '../types'

function emit(context: ToolExecutionContext, toolName: string, input: unknown, output: string): void {
  context.sendEvent(context.sessionId, {
    messageId: context.messageId,
    type: 'tool_call',
    toolName,
    input: typeof input === 'string' ? input : JSON.stringify(input),
    output,
  })
}

function noService(context: ToolExecutionContext, tool: string, args: unknown): string {
  const msg = 'Ops service is not wired in this runtime.'
  emit(context, tool, args, msg)
  return msg
}

// ── schemas ────────────────────────────────────────────────────────────────

export const manageIncidentSchema = z.object({
  action: z.enum(['open', 'get', 'list', 'close']).describe('open a bundle, get one, list, or close it.'),
  id: z.string().optional().describe('Incident id (get/close).'),
  title: z.string().optional().describe('Incident title (open).'),
  notes: z.string().optional().describe('Free-form notes (open/close).'),
  chatId: z.string().optional().describe('Session id to attach (open).'),
  terminals: z.array(z.string()).optional().describe('Terminal ids to attach (open).'),
  recordingId: z.string().optional().describe('Recording id to attach (open).'),
  runId: z.string().optional().describe('Agent run id to attach (open).'),
  status: z.enum(['open', 'closed']).optional().describe('Filter for list.'),
})

export const manageCollabSchema = z.object({
  action: z.enum(['join', 'takeConn', 'whoHasConn', 'list']).describe('Session presence for two operators.'),
  sessionId: z.string().optional().describe('Session id (join/takeConn/whoHasConn).'),
  operator: z.string().optional().describe('Operator name (join/takeConn).'),
})

export const manageJumpPathSchema = z.object({
  action: z.enum(['define', 'list', 'breakGlass', 'allowed']).describe('Named jump paths + time-boxed break-glass.'),
  name: z.string().optional().describe('Path name (define/breakGlass/allowed).'),
  hops: z
    .array(z.object({ host: z.string(), user: z.string().optional(), port: z.number().optional() }))
    .optional()
    .describe('Ordered hops for define — e.g. [{host:"jump"}, {host:"target",user:"admin"}].'),
  ttlSeconds: z.number().optional().describe('Break-glass TTL in seconds (breakGlass). Default 3600.'),
})

export const manageApprovalSchema = z.object({
  action: z.enum(['request', 'list', 'get', 'decide', 'sweep']).describe('Time-boxed approvals; twoPerson needs two distinct approvers.'),
  id: z.string().optional().describe('Approval id (get/decide).'),
  command: z.string().optional().describe('The command awaiting approval (request).'),
  ttlSeconds: z.number().optional().describe('TTL in seconds (request). Default 900.'),
  twoPerson: z.boolean().optional().describe('Require two distinct approvers (request).'),
  who: z.string().optional().describe('Approver name (decide).'),
  approve: z.boolean().optional().describe('true = approve, false = deny (decide).'),
  state: z.enum(['pending', 'approved', 'denied', 'expired']).optional().describe('Filter for list.'),
})

export const snapshotOutputSchema = z.object({
  action: z.enum(['remember', 'list', 'diff']).describe('Baseline command output and diff against it later (config drift).'),
  connection: z.string().describe('Connection/tab name, e.g. CORP-WS2 or cisco-xe-1.'),
  command: z.string().optional().describe('The command whose output is being baselined (remember/diff).'),
  output: z.string().optional().describe('The output text (remember/diff).'),
})

export const replayAgentRunSchema = z.object({
  runId: z.string().describe('Run id from the run ledger to replay.'),
  steps: z
    .array(
      z.object({
        tool: z.string(),
        args: z.unknown().optional(),
        output: z.string().optional().describe('Stubbed output — the real tool is NOT called.'),
      }),
    )
    .describe('Steps with stubbed outputs so a replay never touches live hosts.'),
})

export const planOfflineJoinSchema = z.object({
  domain: z.string().describe('Target AD domain, e.g. corp.local.'),
  machine: z.string().describe('Machine name to join, e.g. EC2AMAZ-C69VULQ.'),
  dcConnection: z.string().describe('Saved connection name for the DC, e.g. CORP-DC1.'),
  memberConnection: z.string().describe('Saved connection name for the member, e.g. CORP-WS2.'),
})

export const netDeviceSchema = z.object({
  action: z.enum(['parseCdp', 'configDiff', 'inConfigMode']).describe('Network-device helpers.'),
  output: z.string().optional().describe('Text to parse (parseCdp) or the prompt to test (inConfigMode).'),
  running: z.string().optional().describe('running-config text (configDiff).'),
  startup: z.string().optional().describe('startup-config text (configDiff).'),
})

// ── handlers ───────────────────────────────────────────────────────────────

export async function manageIncident(
  args: z.infer<typeof manageIncidentSchema>,
  context: ToolExecutionContext,
): Promise<string> {
  const svc = context.opsService
  if (!svc) return noService(context, 'manage_incident', args)
  let msg: string
  if (args.action === 'open') {
    if (!args.title) {
      msg = 'open requires a title'
    } else {
      const inc = svc.openIncident(args.title, {
        sessionId: args.chatId,
        tabIds: args.terminals,
        recordingId: args.recordingId,
        runId: args.runId,
        notes: args.notes,
      })
      msg = `Opened incident ${inc.id} "${inc.title}"${inc.tabIds.length ? ` with ${inc.tabIds.length} terminal(s)` : ''}.`
    }
  } else if (args.action === 'get') {
    const inc = args.id ? svc.getIncident(args.id) : undefined
    msg = inc ? JSON.stringify(inc) : `No incident ${args.id ?? '(missing id)'}`
  } else if (args.action === 'close') {
    const inc = args.id ? svc.closeIncident(args.id, args.notes) : undefined
    msg = inc ? `Closed incident ${inc.id}.` : `No incident ${args.id ?? '(missing id)'}`
  } else {
    const list = svc.listIncidents(args.status)
    msg = list.length
      ? list.map((i) => `- ${i.id} [${i.status}] ${i.title}${i.tabIds.length ? ` tabs=${i.tabIds.join(',')}` : ''}`).join('\n')
      : 'No incidents.'
  }
  emit(context, 'manage_incident', args, msg)
  return msg
}

export async function manageCollab(
  args: z.infer<typeof manageCollabSchema>,
  context: ToolExecutionContext,
): Promise<string> {
  const svc = context.opsService
  if (!svc) return noService(context, 'manage_collab', args)
  const sessionId = args.sessionId || context.sessionId
  let msg: string
  if (args.action === 'list') {
    const rooms = svc.listCollabSessions()
    msg = rooms.length
      ? rooms.map((r) => `- ${r.sessionId} holder=${r.holder ?? 'none'} operators=${r.operators.join(',') || 'none'}`).join('\n')
      : 'No shared sessions yet.'
  } else if (args.action === 'whoHasConn') {
    const p = svc.whoHasConn(sessionId)
    msg = `Session ${p.sessionId}: holder=${p.holder ?? 'none'} operators=${p.operators.join(',') || 'none'}`
  } else {
    const operator = args.operator || 'agent'
    const p = args.action === 'join' ? svc.joinCollab(sessionId, operator) : svc.takeConn(sessionId, operator)
    msg = `${operator} ${args.action === 'join' ? 'joined' : 'has the conn'} for ${p.sessionId}; operators=${p.operators.join(',')} holder=${p.holder ?? 'none'}`
  }
  emit(context, 'manage_collab', args, msg)
  return msg
}

export async function manageJumpPath(
  args: z.infer<typeof manageJumpPathSchema>,
  context: ToolExecutionContext,
): Promise<string> {
  const svc = context.opsService
  if (!svc) return noService(context, 'manage_jump_path', args)
  let msg: string
  if (args.action === 'list') {
    const paths = svc.listJumpPaths()
    msg = paths.length
      ? paths
          .map((p) => {
            const bg = p.breakGlassUntil ? new Date(p.breakGlassUntil).toISOString() : 'none'
            return `- ${p.name} hops=${p.hops.map((h) => h.host).join('->')} breakGlassUntil=${bg}`
          })
          .join('\n')
      : 'No jump paths defined.'
  } else if (args.action === 'allowed') {
    if (!args.name) msg = 'allowed requires name'
    else {
      const r = svc.pathAllowed(args.name)
      msg = `${args.name}: allowed=${r.allowed}${r.expired ? ' (break-glass expired)' : ''}${r.breakGlassUntil ? ` until ${new Date(r.breakGlassUntil).toISOString()}` : ''}`
    }
  } else if (args.action === 'breakGlass') {
    if (!args.name) msg = 'breakGlass requires name'
    else {
      const p = svc.grantBreakGlass(args.name, (args.ttlSeconds ?? 3600) * 1000)
      msg = p
        ? `Break-glass granted on ${p.name} until ${new Date(p.breakGlassUntil ?? 0).toISOString()}`
        : `No jump path "${args.name}"`
    }
  } else {
    if (!args.name || !args.hops?.length) msg = 'define requires name and hops'
    else {
      const p = svc.defineJumpPath(args.name, args.hops)
      msg = `Defined jump path ${p.name} with ${p.hops.length} hop(s): ${p.hops.map((h) => h.host).join(' -> ')}`
    }
  }
  emit(context, 'manage_jump_path', args, msg)
  return msg
}

export async function manageApproval(
  args: z.infer<typeof manageApprovalSchema>,
  context: ToolExecutionContext,
): Promise<string> {
  const svc = context.opsService
  if (!svc) return noService(context, 'manage_approval', args)
  let msg: string
  if (args.action === 'request') {
    if (!args.command) msg = 'request requires command'
    else {
      const a = svc.requestApproval(args.command, (args.ttlSeconds ?? 900) * 1000, args.twoPerson === true)
      msg =
        `Approval ${a.id} requested for: ${a.command}\n` +
        `twoPerson=${a.twoPerson} expires=${new Date(a.expiresAt).toISOString()}\n` +
        (a.twoPerson ? 'Two DISTINCT approvers are required before this may run.' : 'One approver suffices.')
    }
  } else if (args.action === 'get') {
    const a = args.id ? svc.getApproval(args.id) : undefined
    msg = a ? JSON.stringify(a) : `No approval ${args.id ?? '(missing id)'}`
  } else if (args.action === 'sweep') {
    msg = `Expired ${svc.sweepExpiredApprovals()} approval(s).`
  } else if (args.action === 'decide') {
    if (!args.id || !args.who || typeof args.approve !== 'boolean') msg = 'decide requires id, who and approve'
    else {
      const r = svc.decideApproval(args.id, args.who, args.approve)
      msg = `approval ${r.approval.id}: state=${r.approval.state}${r.reason ? ` (${r.reason})` : ''}`
    }
  } else {
    const list = svc.listApprovals(args.state)
    msg = list.length
      ? list
          .map((a) => `- ${a.id} [${a.state}]${a.twoPerson ? ' (2-person)' : ''} ${a.command} expires=${new Date(a.expiresAt).toISOString()}`)
          .join('\n')
      : 'No approvals.'
  }
  emit(context, 'manage_approval', args, msg)
  return msg
}

export async function snapshotOutput(
  args: z.infer<typeof snapshotOutputSchema>,
  context: ToolExecutionContext,
): Promise<string> {
  const svc = context.opsService
  if (!svc) return noService(context, 'snapshot_output', args)
  let msg: string
  if (args.action === 'list') {
    const snaps = svc.listSnapshots(args.connection)
    msg = snaps.length
      ? snaps.map((s) => `- ${s.connection} :: ${s.command} (${s.output.length} chars @ ${new Date(s.at).toISOString()})`).join('\n')
      : `No snapshots for ${args.connection}.`
  } else if (args.action === 'remember') {
    if (!args.command || args.output === undefined) msg = 'remember requires command and output'
    else {
      svc.rememberOutput(args.connection, args.command, args.output)
      msg = `Baseline stored for ${args.connection} :: ${args.command} (${args.output.length} chars).`
    }
  } else {
    if (!args.command || args.output === undefined) msg = 'diff requires command and output'
    else {
      const d = svc.diffOutput(args.connection, args.command, args.output)
      msg = d.previous === null
        ? `No baseline existed — stored this output (${args.output.length} chars) as the baseline for ${args.connection} :: ${args.command}.`
        : `changed=${d.changed} for ${args.connection} :: ${args.command}`
    }
  }
  emit(context, 'snapshot_output', args, msg)
  return msg
}

export async function replayAgentRun(
  args: z.infer<typeof replayAgentRunSchema>,
  context: ToolExecutionContext,
): Promise<string> {
  const svc = context.opsService
  if (!svc) return noService(context, 'replay_agent_run', args)
  const r = svc.replay(
    args.runId,
    args.steps.map((s) => ({
      tool: s.tool,
      args: (s.args && typeof s.args === 'object' && !Array.isArray(s.args) ? s.args : {}) as Record<string, unknown>,
      stub: s.output ?? '',
    })),
  )
  const msg = `Replay ${args.runId}: ${r.steps.length} step(s) completed. Tools that would have been called: ${r.wouldHaveCalled.join(', ') || '(none)'}. No live tool was called.`
  emit(context, 'replay_agent_run', args, msg)
  return msg
}

export async function planOfflineJoin(
  args: z.infer<typeof planOfflineJoinSchema>,
  context: ToolExecutionContext,
): Promise<string> {
  const svc = context.opsService
  if (!svc) return noService(context, 'plan_offline_join', args)
  svc.planOfflineJoin(args)
  const lines = [
    `Offline join plan for ${args.machine} into ${args.domain}:`,
    `1. on ${args.dcConnection}: ${svc.djoinProvision(args.domain, args.machine)}`,
    `2. copy the blob to ${args.memberConnection} (no SMB required)`,
    `3. on ${args.memberConnection}: ${svc.djoinRequest()}`,
    `4. reboot ${args.memberConnection}, then verify with estate_facts / collect_facts`,
    `Use this INSTEAD of Add-Computer when NetUseAdd \\\\DC\\IPC$ fails with 64 (network name no longer available).`,
  ]
  const msg = lines.join('\n')
  emit(context, 'plan_offline_join', args, msg)
  return msg
}

export async function netDevice(
  args: z.infer<typeof netDeviceSchema>,
  context: ToolExecutionContext,
): Promise<string> {
  const svc = context.opsService
  if (!svc) return noService(context, 'net_device', args)
  let msg: string
  if (args.action === 'parseCdp') {
    const neighbors = svc.parseCdp(args.output ?? '')
    msg = neighbors.length
      ? neighbors.map((n) => `- ${n.device} local=${n.localIntf} remote=${n.remoteIntf}`).join('\n')
      : 'No CDP neighbors parsed (empty or unrecognised output).'
  } else if (args.action === 'inConfigMode') {
    msg = svc.inConfigMode(args.output ?? '') ? 'Device prompt looks like CONFIG mode.' : 'Not in config mode.'
  } else {
    const d = svc.configDiff(args.running ?? '', args.startup ?? '')
    msg = d.changed ? `running-config DIFFERS from startup-config:\n${d.unified.slice(0, 4000)}` : 'running-config matches startup-config.'
  }
  emit(context, 'net_device', args, msg)
  return msg
}

// ── descriptions ───────────────────────────────────────────────────────────

export const MANAGE_INCIDENT_DESCRIPTION =
  'Incident bundles: open a durable record that ties this chat session, terminal tabs, a recording id and an agent run id together, so an incident can be reopened tomorrow from one id. Actions: open/get/list/close.'

export const MANAGE_COLLAB_DESCRIPTION =
  'Two operators, one agent session. join records an operator on a session; takeConn records WHO is driving ("I have the conn"); whoHasConn/list report presence. Presence is advisory — it does not block another operator from typing.'

export const MANAGE_JUMP_PATH_DESCRIPTION =
  'Named multi-hop jump paths (laptop -> jump -> target) with TIME-BOXED break-glass. define/list/breakGlass/allowed. Break-glass expires on its own after ttlSeconds — grant the minimum you need.'

export const MANAGE_APPROVAL_DESCRIPTION =
  'Time-boxed approvals for consequential commands. request/list/get/decide/sweep. twoPerson=true requires TWO DISTINCT approvers (the same name twice does not count). Expired approvals cannot be decided; sweep expires them.'

export const SNAPSHOT_OUTPUT_DESCRIPTION =
  'Baseline a command output per connection and diff against it later — config/output drift without a full GitOps manifest. remember/list/diff. diff updates the baseline so each call compares against the previous state.'

export const REPLAY_AGENT_RUN_DESCRIPTION =
  'Replay a previous agent run with STUBBED tool outputs so you can see what the model would have done WITHOUT touching live hosts. Use to debug or harden an agent run.'

export const PLAN_OFFLINE_JOIN_DESCRIPTION =
  'Plan an OFFLINE domain join (djoin /provision on the DC, djoin /requestODJ on the member). Use this instead of Add-Computer when SMB IPC$ is blocked (NetUseAdd fails with 64) — no NETLOGON/SMB needed.'

export const NET_DEVICE_DESCRIPTION =
  'Network-device helpers: parseCdp (show cdp neighbors -> structured), configDiff (running vs startup with a unified diff), inConfigMode (is the prompt in config mode).'
