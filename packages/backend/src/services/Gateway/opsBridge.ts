/**
 * opsBridge — surfaces the v3.8.x operator capabilities as WebSocket RPC
 * methods (`ops:*`), mirroring observabilityBridge.
 *
 * Same pattern as the other *Bridge objects: the adapter strips the prefix and
 * dispatches to the named handler here. Every capability below is also exposed
 * as an agent tool (services/AgentHelper/tools/ops_tools.ts) so the agent and an
 * RPC client share one implementation.
 */
import type { OpsService } from '../ops/opsService'

export interface OpsBridgeDeps {
  /** Returns the OpsService, or null when the runtime did not create one. */
  ops: () => OpsService | null
}

function requireOps(deps: OpsBridgeDeps): OpsService {
  const o = deps.ops()
  if (!o) throw new Error('ops service is not available on this runtime')
  return o
}

export interface OpsBridge {
  // collab
  collabJoin: (p: { sessionId: string; operator: string }) => Promise<unknown>
  collabTakeConn: (p: { sessionId: string; operator: string }) => Promise<unknown>
  collabWhoHasConn: (p: { sessionId: string }) => Promise<unknown>
  collabList: () => Promise<unknown>
  // incidents
  incidentOpen: (p: { title: string; chatId?: string; terminals?: string[]; recordingId?: string; runId?: string; notes?: string }) => Promise<unknown>
  incidentGet: (p: { id: string }) => Promise<unknown>
  incidentList: (p?: { status?: 'open' | 'closed' }) => Promise<unknown>
  incidentClose: (p: { id: string; notes?: string }) => Promise<unknown>
  // jump paths
  jumpPathDefine: (p: { name: string; hops: Array<{ host: string; user?: string; port?: number }> }) => Promise<unknown>
  jumpPathList: () => Promise<unknown>
  jumpPathBreakGlass: (p: { name: string; ttlSeconds: number }) => Promise<unknown>
  jumpPathAllowed: (p: { name: string }) => Promise<unknown>
  // output snapshots
  snapshotRemember: (p: { connection: string; command: string; output: string }) => Promise<unknown>
  snapshotList: (p?: { connection?: string }) => Promise<unknown>
  snapshotDiff: (p: { connection: string; command: string; output: string }) => Promise<unknown>
  // approvals
  approvalRequest: (p: { command: string; ttlSeconds?: number; twoPerson?: boolean }) => Promise<unknown>
  approvalList: (p?: { state?: 'pending' | 'approved' | 'denied' | 'expired' }) => Promise<unknown>
  approvalGet: (p: { id: string }) => Promise<unknown>
  approvalDecide: (p: { id: string; who: string; approve: boolean }) => Promise<unknown>
  approvalSweep: () => Promise<unknown>
  // replay
  replayRun: (p: { runId: string; steps: Array<{ tool: string; args?: unknown; output?: string }> }) => Promise<unknown>
  // djoin
  djoinPlan: (p: { domain: string; machine: string; dcConnection: string; memberConnection: string }) => Promise<unknown>
  // network device
  netParseCdp: (p: { output: string }) => Promise<unknown>
  netConfigDiff: (p: { running: string; startup: string }) => Promise<unknown>
  netInConfigMode: (p: { prompt: string }) => Promise<unknown>
}

const DEFAULT_APPROVAL_TTL_SECONDS = 900

export function createOpsBridge(deps: OpsBridgeDeps): OpsBridge {
  return {
    // ── collab ─────────────────────────────────────────────────────────────
    collabJoin: async (p) => requireOps(deps).joinCollab(p.sessionId, p.operator),
    collabTakeConn: async (p) => requireOps(deps).takeConn(p.sessionId, p.operator),
    collabWhoHasConn: async (p) => requireOps(deps).whoHasConn(p.sessionId),
    collabList: async () => ({ sessions: requireOps(deps).listCollabSessions() }),

    // ── incidents ──────────────────────────────────────────────────────────
    incidentOpen: async (p) =>
      requireOps(deps).openIncident(p.title, {
        sessionId: p.chatId,
        tabIds: p.terminals,
        recordingId: p.recordingId,
        runId: p.runId,
        notes: p.notes,
      }),
    incidentGet: async (p) => {
      const inc = requireOps(deps).getIncident(p.id)
      if (!inc) throw new Error(`no incident ${p.id}`)
      return inc
    },
    incidentList: async (p) => ({ incidents: requireOps(deps).listIncidents(p?.status) }),
    incidentClose: async (p) => {
      const inc = requireOps(deps).closeIncident(p.id, p.notes)
      if (!inc) throw new Error(`no incident ${p.id}`)
      return inc
    },

    // ── jump paths / break-glass ───────────────────────────────────────────
    jumpPathDefine: async (p) => requireOps(deps).defineJumpPath(p.name, p.hops),
    jumpPathList: async () => ({ paths: requireOps(deps).listJumpPaths() }),
    jumpPathBreakGlass: async (p) =>
      requireOps(deps).grantBreakGlass(p.name, Math.max(0, p.ttlSeconds) * 1000),
    jumpPathAllowed: async (p) => requireOps(deps).pathAllowed(p.name),

    // ── output snapshots ───────────────────────────────────────────────────
    snapshotRemember: async (p) => requireOps(deps).rememberOutput(p.connection, p.command, p.output),
    snapshotList: async (p) => ({ snapshots: requireOps(deps).listSnapshots(p?.connection) }),
    snapshotDiff: async (p) => requireOps(deps).diffOutput(p.connection, p.command, p.output),

    // ── approvals ──────────────────────────────────────────────────────────
    approvalRequest: async (p) =>
      requireOps(deps).requestApproval(
        p.command,
        Math.max(1, p.ttlSeconds ?? DEFAULT_APPROVAL_TTL_SECONDS) * 1000,
        p.twoPerson === true,
      ),
    approvalList: async (p) => ({ approvals: requireOps(deps).listApprovals(p?.state) }),
    approvalGet: async (p) => {
      const a = requireOps(deps).getApproval(p.id)
      if (!a) throw new Error(`no approval ${p.id}`)
      return a
    },
    approvalDecide: async (p) => requireOps(deps).decideApproval(p.id, p.who, p.approve),
    approvalSweep: async () => ({ expired: requireOps(deps).sweepExpiredApprovals() }),

    // ── agent replay ───────────────────────────────────────────────────────
    replayRun: async (p) =>
      requireOps(deps).replay(
        p.runId,
        p.steps.map((s) => ({
          tool: s.tool,
          args: (s.args && typeof s.args === 'object' && !Array.isArray(s.args)
            ? (s.args as Record<string, unknown>)
            : {}) as Record<string, unknown>,
          stub: typeof s.output === 'string' ? s.output : '',
        })),
      ),

    // ── offline domain join ────────────────────────────────────────────────
    djoinPlan: async (p) => requireOps(deps).planOfflineJoin(p),

    // ── network device ─────────────────────────────────────────────────────
    netParseCdp: async (p) => ({ neighbors: requireOps(deps).parseCdp(p.output) }),
    netConfigDiff: async (p) => requireOps(deps).configDiff(p.running, p.startup),
    netInConfigMode: async (p) => ({ inConfigMode: requireOps(deps).inConfigMode(p.prompt) }),
  }
}

export const OPS_METHODS = [
  'ops:collabJoin',
  'ops:collabTakeConn',
  'ops:collabWhoHasConn',
  'ops:collabList',
  'ops:incidentOpen',
  'ops:incidentGet',
  'ops:incidentList',
  'ops:incidentClose',
  'ops:jumpPathDefine',
  'ops:jumpPathList',
  'ops:jumpPathBreakGlass',
  'ops:jumpPathAllowed',
  'ops:snapshotRemember',
  'ops:snapshotList',
  'ops:snapshotDiff',
  'ops:approvalRequest',
  'ops:approvalList',
  'ops:approvalGet',
  'ops:approvalDecide',
  'ops:approvalSweep',
  'ops:replayRun',
  'ops:djoinPlan',
  'ops:netParseCdp',
  'ops:netConfigDiff',
  'ops:netInConfigMode',
] as const

export type OpsMethod = (typeof OPS_METHODS)[number]

/** Registry metadata for gateway:describe. */
export const OPS_METHOD_INFO: Array<{ name: string; description: string; since: string }> = [
  { name: 'ops:collabJoin', description: 'Join a shared agent session as an operator (two-operator collab).', since: '3.8.1' },
  { name: 'ops:collabTakeConn', description: 'Take the conn for a shared session — records who is currently driving.', since: '3.8.1' },
  { name: 'ops:collabWhoHasConn', description: 'Who currently holds the conn for a session, plus joined operators.', since: '3.8.1' },
  { name: 'ops:collabList', description: 'List sessions with operators and current holder.', since: '3.8.1' },
  { name: 'ops:incidentOpen', description: 'Open an incident bundle (chat + terminals + recording + run id). Persisted.', since: '3.8.1' },
  { name: 'ops:incidentGet', description: 'Fetch one incident bundle by id.', since: '3.8.1' },
  { name: 'ops:incidentList', description: 'List incident bundles (optionally by status).', since: '3.8.1' },
  { name: 'ops:incidentClose', description: 'Close an incident bundle with optional notes.', since: '3.8.1' },
  { name: 'ops:jumpPathDefine', description: 'Define a named multi-hop jump path (laptop → jump → target).', since: '3.8.1' },
  { name: 'ops:jumpPathList', description: 'List defined jump paths and their break-glass state.', since: '3.8.1' },
  { name: 'ops:jumpPathBreakGlass', description: 'Grant time-boxed break-glass (TTL seconds) on a jump path.', since: '3.8.1' },
  { name: 'ops:jumpPathAllowed', description: 'Is a jump path usable right now (break-glass valid) or expired?', since: '3.8.1' },
  { name: 'ops:snapshotRemember', description: 'Store command output as the baseline for a connection+command.', since: '3.8.1' },
  { name: 'ops:snapshotList', description: 'List stored output snapshots.', since: '3.8.1' },
  { name: 'ops:snapshotDiff', description: 'Diff new output against the stored baseline, then update the baseline.', since: '3.8.1' },
  { name: 'ops:approvalRequest', description: 'Request an approval with a TTL; twoPerson requires two distinct approvers.', since: '3.8.1' },
  { name: 'ops:approvalList', description: 'List approvals (sweeps expired first).', since: '3.8.1' },
  { name: 'ops:approvalGet', description: 'Get one approval by id.', since: '3.8.1' },
  { name: 'ops:approvalDecide', description: 'Approve or deny an approval as a named person.', since: '3.8.1' },
  { name: 'ops:approvalSweep', description: 'Expire pending approvals past their TTL; returns the count.', since: '3.8.1' },
  { name: 'ops:replayRun', description: 'Replay agent steps with stubbed tool outputs — debug without touching live hosts.', since: '3.8.1' },
  { name: 'ops:djoinPlan', description: 'Plan offline domain join (djoin provision + request) across a DC and a member.', since: '3.8.1' },
  { name: 'ops:netParseCdp', description: 'Parse `show cdp neighbors` output into structured neighbors.', since: '3.8.1' },
  { name: 'ops:netConfigDiff', description: 'Diff running-config vs startup-config for a network device.', since: '3.8.1' },
  { name: 'ops:netInConfigMode', description: 'Detect whether a device prompt is in config mode.', since: '3.8.1' },
]
