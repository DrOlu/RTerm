/**
 * opsService — the wired surface for the v3.8.x operator modules.
 *
 * Before this existed, services/ops/* were pure modules with tests but no
 * importer outside their spec: collabSession, approvalQueue, incidentBundle,
 * jumpPath, outputSnapshot, agentReplay, djoinPlaybook, netDevice were
 * unreachable from the app, the agent and any RPC client.
 *
 * This facade binds them together and gives every capability ONE entry point
 * used by both the gateway (ops:* methods) and the agent tools, so the two can
 * never drift. Durable state lives in OpsStore (SQLite); session-scoped state
 * (who holds the conn, replay) stays in the pure modules' maps.
 */
import {
  joinSession,
  takeConn,
  whoHasConn,
  type Presence,
} from './collabSession'
import {
  replayWithStubs,
  breakpointBefore,
  type ReplayStep,
  type ReplayResult,
} from './agentReplay'
import {
  planOfflineJoin,
  djoinProvisionCommand,
  djoinRequestCommand,
  type DjoinPlan,
} from './djoinPlaybook'
import { parseCdpNeighbors, configDiff, inConfigMode } from './netDevice'
import { OpsStore, type ApprovalRow, type IncidentRow, type JumpPathRow, type SnapshotRow } from './opsStore'

export interface OpsServiceDeps {
  /** Override for tests. Defaults to the history storage dir. */
  filePath?: string
}

export class OpsService {
  readonly store: OpsStore
  /** sessionId → operators, for the presence listing. */
  private readonly rooms = new Map<string, Presence>()

  constructor(deps: OpsServiceDeps = {}) {
    this.store = new OpsStore({ filePath: deps.filePath })
  }

  // ── collaborate (two operators, one session) ─────────────────────────────
  joinCollab(sessionId: string, operator: string): Presence {
    const p = joinSession(sessionId, operator)
    this.rooms.set(sessionId, p)
    return p
  }

  takeConn(sessionId: string, operator: string): Presence {
    const p = takeConn(sessionId, operator)
    this.rooms.set(sessionId, p)
    return p
  }

  whoHasConn(sessionId: string): { holder: string | null; operators: string[]; sessionId: string } {
    const p = this.rooms.get(sessionId) ?? joinSession(sessionId, 'system')
    this.rooms.set(sessionId, p)
    return { sessionId, holder: whoHasConn(sessionId), operators: p.operators }
  }

  listCollabSessions(): Presence[] {
    return [...this.rooms.values()]
  }

  // ── incidents ────────────────────────────────────────────────────────────
  openIncident(title: string, parts?: Parameters<OpsStore['openIncident']>[1]): IncidentRow {
    return this.store.openIncident(title, parts)
  }
  getIncident(id: string): IncidentRow | undefined {
    return this.store.getIncident(id)
  }
  listIncidents(status?: 'open' | 'closed'): IncidentRow[] {
    return this.store.listIncidents(status)
  }
  closeIncident(id: string, notes?: string): IncidentRow | undefined {
    return this.store.closeIncident(id, notes)
  }

  // ── jump paths + break-glass ─────────────────────────────────────────────
  defineJumpPath(name: string, hops: JumpPathRow['hops']): JumpPathRow {
    return this.store.defineJumpPath(name, hops)
  }
  listJumpPaths(): JumpPathRow[] {
    return this.store.listJumpPaths()
  }
  grantBreakGlass(name: string, ttlMs: number): JumpPathRow | undefined {
    if (!this.store.listJumpPaths().some((p) => p.name === name)) {
      throw new Error(`unknown jump path "${name}" — define it first`)
    }
    return this.store.grantBreakGlass(name, ttlMs)
  }
  pathAllowed(name: string): { allowed: boolean; breakGlassUntil?: number; expired?: boolean } {
    return this.store.pathAllowed(name)
  }

  // ── output snapshots + drift ─────────────────────────────────────────────
  rememberOutput(connection: string, command: string, output: string): SnapshotRow {
    return this.store.rememberOutput(connection, command, output)
  }
  listSnapshots(connection?: string): SnapshotRow[] {
    return this.store.listSnapshots(connection)
  }
  diffOutput(
    connection: string,
    command: string,
    nextOutput: string,
  ): { previous: string | null; current: string; changed: boolean } {
    return this.store.diffAndRemember(connection, command, nextOutput)
  }

  // ── approvals (TTL + two-person) ─────────────────────────────────────────
  requestApproval(command: string, ttlMs: number, twoPerson = false): ApprovalRow {
    return this.store.requestApproval(command, ttlMs, twoPerson)
  }
  listApprovals(state?: ApprovalRow['state']): ApprovalRow[] {
    this.store.sweepExpired()
    return this.store.listApprovals(state)
  }
  getApproval(id: string): ApprovalRow | undefined {
    this.store.sweepExpired()
    return this.store.getApproval(id)
  }
  decideApproval(id: string, who: string, approve: boolean): ReturnType<OpsStore['decide']> {
    return this.store.decide(id, who, approve)
  }
  sweepExpiredApprovals(): number {
    return this.store.sweepExpired()
  }

  // ── agent replay (debug without touching live hosts) ─────────────────────
  replay(runId: string, steps: ReplayStep[]): ReplayResult {
    return replayWithStubs(runId, steps)
  }
  shouldBreakpointBefore(tool: string, nextTool: string): boolean {
    return breakpointBefore(tool, nextTool)
  }

  // ── offline domain join ──────────────────────────────────────────────────
  planOfflineJoin(opts: Parameters<typeof planOfflineJoin>[0]): DjoinPlan {
    return planOfflineJoin(opts)
  }
  djoinProvision(domain: string, machine: string, savefile?: string): string {
    return djoinProvisionCommand(domain, machine, savefile)
  }
  djoinRequest(loadfile?: string): string {
    return djoinRequestCommand(loadfile)
  }

  // ── network device helpers ───────────────────────────────────────────────
  parseCdp(showCdp: string): ReturnType<typeof parseCdpNeighbors> {
    return parseCdpNeighbors(showCdp)
  }
  configDiff(running: string, startup: string): ReturnType<typeof configDiff> {
    return configDiff(running, startup)
  }
  inConfigMode(prompt: string): boolean {
    return inConfigMode(prompt)
  }
}
