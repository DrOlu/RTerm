/**
 * graph_tools — the agent-facing graph execution layer (v3.5.0).
 *
 * THE GAP THIS CLOSES
 * -------------------
 * RTerm already had graph execution in three places — the agent's own
 * LangGraph StateGraph loop, the playbook DAG scheduler (dependsOn +
 * parallel batches), and the AgentSpan/Conductor bridge (JOIN tasks) — but
 * none of them were reachable by the AGENT as a live decision. The agent
 * could run steps in a loop and could use fleet tools for implicit
 * parallelism, but it could not say "fan out these checks, join, branch on
 * the results, fan out the patches." The graph lived in playbook YAML
 * written last week, not in the agent's reasoning right now.
 *
 * WHAT THIS ADDS
 * --------------
 * `plan_graph`  — the agent describes nodes + edges in JSON; the existing
 *                 dagScheduler validates (cycles, unknown deps) and plans
 *                 the parallel batches. Returns the plan for review.
 * `run_graph`   — executes the plan against the agent's own tool surface:
 *                 each node is a tool call (exec_command, read_file, …),
 *                 batches run in parallel with a bounded pool, and a node's
 *                 result is passed to its dependents. Fan-in joins naturally:
 *                 a node with multiple dependsOn waits for all of them.
 *
 * DESIGN RULES (inherited from the existing engine):
 *   - Pure planning (planDag/chunk) is reused, not reimplemented.
 *   - Every node is a REAL tool call through toolImplementations — the same
 *     guardrails (command policy, terminal targets) apply inside a graph.
 *   - Bounded: max nodes, max parallel, per-node timeout. A graph can never
 *     become a worm.
 *   - A node failure stops its dependents (they would run on missing input)
 *     but NOT the whole graph unless the node is marked critical.
 *   - Structured result: per-node status + output, serialized like the fleet
 *     tools so the agent can reason over the outcome.
 */

import { z } from 'zod'
import { planDag, chunk } from '../../automation/dagScheduler'
import type { ToolExecutionContext } from '../types'

// ---------------------------------------------------------------- limits
const MAX_GRAPH_NODES = 25
const MAX_GRAPH_PARALLEL = 5
const GRAPH_NODE_TIMEOUT_MS = 120_000

// ---------------------------------------------------------------- schema

export const graphNodeSchema = z.object({
  id: z.string().min(1).max(64).describe('Unique node id, e.g. "check-ws1".'),
  tool: z.string().min(1).describe(
    'The tool to call for this node, e.g. "exec_command", "read_file", "run_fleet_command", "get_metrics".',
  ),
  args: z.record(z.string(), z.unknown()).describe(
    'The tool arguments for this node. {{nodeId}} placeholders inside string values are replaced with that node\'s result text before the call.',
  ),
  dependsOn: z.array(z.string().min(1)).optional().describe(
    'Node ids this node waits for. Omit (or empty) for a root node that runs immediately. A node with multiple dependencies is a JOIN — it waits for ALL of them.',
  ),
  critical: z.boolean().optional().describe(
    'If true (default false), a failure of this node aborts the whole graph. Non-critical failures only stop their dependents.',
  ),
})

export const planGraphSchema = z.object({
  nodes: z.array(graphNodeSchema).min(1).max(MAX_GRAPH_NODES),
  maxParallel: z.number().int().min(1).max(MAX_GRAPH_PARALLEL).optional().describe(
    `Max nodes running at once (default ${MAX_GRAPH_PARALLEL}).`,
  ),
  dryRun: z.boolean().optional().describe(
    'If true (default), only validate and return the plan WITHOUT executing. Always review the plan before running.',
  ),
})

export const runGraphSchema = planGraphSchema.extend({
  dryRun: z.boolean().optional().describe(
    'If true, validate and return the plan without executing. Default false — run_graph executes.',
  ),
})

export type PlanGraphArgs = z.infer<typeof planGraphSchema>
export type RunGraphArgs = z.infer<typeof runGraphSchema>
export type GraphNode = z.infer<typeof graphNodeSchema>

// ---------------------------------------------------------------- planning

export interface GraphPlan {
  batches: string[][]
  totalNodes: number
  maxParallel: number
  joins: string[]
  roots: string[]
}

/** Plan a graph: validate + batch. Pure — no execution.
 * Throws (planDag) on cycles or unknown dependsOn references. */
export function planGraph(nodes: GraphNode[], maxParallel?: number): GraphPlan {
  // Map graph nodes onto the PlaybookStep shape the dagScheduler already
  // validates. dependsOn is EXPLICIT here — no linear default: a graph node
  // with no dependsOn is a ROOT, not "the previous step".
  const steps: import('../../../types').PlaybookStep[] = nodes.map(
    (n: GraphNode): import('../../../types').PlaybookStep => ({
      id: n.id,
      name: n.id,
      kind: 'command' as const,
      dependsOn: n.dependsOn ?? [],
    }),
  )

  const { batches } = planDag(steps)
  const named: string[][] = batches.map((b: number[]) =>
    b.map((i: number) => nodes[i].id),
  )
  return {
    batches: named,
    totalNodes: nodes.length,
    maxParallel: Math.min(maxParallel ?? MAX_GRAPH_PARALLEL, MAX_GRAPH_PARALLEL),
    joins: nodes.filter((n: GraphNode) => (n.dependsOn?.length ?? 0) > 1).map((n: GraphNode) => n.id),
    roots: nodes.filter((n: GraphNode) => (n.dependsOn?.length ?? 0) === 0).map((n: GraphNode) => n.id),
  }
}

/** Detect duplicate node ids up front (planDag maps by index and would
 * silently accept duplicates). Returns the duplicate id or null. */
export function findDuplicateNodeIds(nodes: GraphNode[]): string | null {
  const seen = new Set<string>()
  for (const n of nodes) {
    if (seen.has(n.id)) return n.id
    seen.add(n.id)
  }
  return null
}

// ---------------------------------------------------------------- templating

/** Replace {{nodeId}} placeholders in a node's string args with the
 * dependency results. Only string values are templated; objects/arrays are
 * left as-is (a tool that wants structured input takes it literally). */
export function resolveNodeArgs(
  args: Record<string, unknown>,
  results: Map<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args ?? {})) {
    if (typeof v === 'string') {
      out[k] = v.replace(/\{\{([a-zA-Z0-9_-]+)\}\}/g, (whole, id) => {
        const r = results.get(id)
        return r === undefined ? whole : r
      })
    } else {
      out[k] = v
    }
  }
  return out
}

// ---------------------------------------------------------------- execution

interface NodeOutcome {
  id: string
  status: 'ok' | 'failed' | 'skipped'
  output: string
}

function truncate(s: string, max = 1500): string {
  if (s.length <= max) return s
  return `${s.slice(0, max)}…[truncated ${s.length - max} chars]`
}

/**
 * Execute a graph against the agent's own tool surface. Batches from the
 * plan run sequentially; nodes within a batch run in parallel (bounded by
 * maxParallel). A node's tool result is recorded and available to its
 * dependents via {{nodeId}} templating. A failed node marks its dependents
 * skipped (they would run on missing input); a CRITICAL failed node aborts
 * the whole graph.
 */
export async function runGraph(
  args: RunGraphArgs,
  context: ToolExecutionContext,
  toolImplementations: { executeToolByName: (tc: any, ec: any) => Promise<string> },
): Promise<string> {
  const { nodes } = args
  const dup = findDuplicateNodeIds(nodes)
  if (dup) return `Graph rejected: duplicate node id "${dup}".`

  let plan: GraphPlan
  try {
    plan = planGraph(nodes, args.maxParallel)
  } catch (e) {
    return `Graph invalid: ${(e as Error).message.replace(/^Step "/, 'Node "')}\nNothing was executed.`
  }
  const results = new Map<string, string>()
  const outcomes: NodeOutcome[] = []
  const failedCritical = new Set<string>()
  const failedAny = new Set<string>()
  const skipped = new Set<string>()

  // A node is skipped if ANY of its dependencies failed or was skipped
  // (transitively). failedAny covers non-critical failures — their
  // dependents must not run on missing input.
  const isBlocked = (n: GraphNode): boolean =>
    (n.dependsOn ?? []).some((d) => failedAny.has(d) || skipped.has(d))

  for (const batch of plan.batches) {
    if (failedCritical.size > 0) break // critical failure aborts the graph
    const runnable = batch
      .map((id) => nodes.find((n) => n.id === id)!)
      .filter((n) => {
        if (isBlocked(n)) {
          skipped.add(n.id)
          outcomes.push({ id: n.id, status: 'skipped', output: 'A dependency failed or was skipped.' })
          return false
        }
        return true
      })
    if (runnable.length === 0) continue

    const chunks = chunk(runnable, plan.maxParallel)
    for (const group of chunks) {
      const settled = await Promise.allSettled(
        group.map(async (n: GraphNode) => {
          const resolved = resolveNodeArgs(n.args ?? {}, results)
          const tc = { name: n.tool, args: resolved }
          const timer = new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error(`node timeout ${GRAPH_NODE_TIMEOUT_MS}ms`)), GRAPH_NODE_TIMEOUT_MS).unref(),
          )
          const output = await Promise.race([
            toolImplementations.executeToolByName(tc, context),
            timer,
          ])
          return { id: n.id, output: String(output ?? '') }
        }),
      )
      settled.forEach((s: PromiseSettledResult<{ id: string; output: string }>, i: number) => {
        const n = group[i]
        if (s.status === 'fulfilled') {
          results.set(n.id, s.value.output)
          outcomes.push({ id: n.id, status: 'ok', output: truncate(s.value.output) })
        } else {
          const msg = s.reason instanceof Error ? s.reason.message : String(s.reason)
          outcomes.push({ id: n.id, status: 'failed', output: truncate(msg) })
          failedAny.add(n.id)
          if (n.critical) failedCritical.add(n.id)
        }
      })
    }
  }

  const okCount = outcomes.filter((o) => o.status === 'ok').length
  const failCount = outcomes.filter((o) => o.status === 'failed').length
  const skipCount = outcomes.filter((o) => o.status === 'skipped').length
  const aborted = failedCritical.size > 0

  const lines = outcomes.map(
    (o) => `### ${o.id} [${o.status.toUpperCase()}]\n${o.output || '(no output)'}`,
  )
  return (
    `<graph_results nodes="${outcomes.length}" ok="${okCount}" failed="${failCount}" skipped="${skipCount}"${aborted ? ' aborted="critical-node-failed"' : ''}>\n` +
    `${lines.join('\n\n')}\n` +
    `</graph_results>\n\n` +
    `Graph finished: ${okCount} ok, ${failCount} failed, ${skipCount} skipped` +
    `${aborted ? ' — ABORTED because a critical node failed; remaining nodes were not run.' : '.'}` +
    (aborted ? '' : ' Node results are addressable as {{nodeId}} in subsequent calls.')
  )
}

// ---------------------------------------------------------------- tool fns

export async function planGraphTool(args: PlanGraphArgs, _context: ToolExecutionContext): Promise<string> {
  const dup = findDuplicateNodeIds(args.nodes)
  if (dup) return `Graph rejected: duplicate node id "${dup}".`

  let plan: GraphPlan
  try {
    plan = planGraph(args.nodes, args.maxParallel)
  } catch (e) {
    return `Graph invalid: ${(e as Error).message}\nFix the nodes/dependsOn and re-plan.`
  }

  const batchLines = plan.batches
    .map((b, i) => `  batch ${i}: ${b.join(', ')}`)
    .join('\n')
  return (
    `Graph plan (validated, ${plan.totalNodes} nodes):\n` +
    `${batchLines}\n` +
    `roots: ${plan.roots.join(', ') || '(none)'}\n` +
    `joins (fan-in): ${plan.joins.join(', ') || '(none)'}\n` +
    `max parallel: ${plan.maxParallel}\n\n` +
    `The plan is valid — no cycles, all dependsOn references resolve. ` +
    `Batches run in order; nodes within a batch run in parallel. ` +
    `Run it with run_graph (the same nodes), or adjust and re-plan.`
  )
}

export async function runGraphTool(
  args: RunGraphArgs,
  context: ToolExecutionContext,
): Promise<string> {
  if (args.dryRun) {
    return planGraphTool(args, context)
  }
  const dup = findDuplicateNodeIds(args.nodes)
  if (dup) return `Graph rejected: duplicate node id "${dup}".`
  try {
    planGraph(args.nodes, args.maxParallel) // validate before executing
  } catch (e) {
    return `Graph invalid: ${(e as Error).message.replace(/^Step "/, 'Node "')}\nNothing was executed.`
  }
  // Late-bound to avoid a circular import with the service that owns the
  // tool dispatch: the context carries what we need, and the caller wires
  // executeToolByName.
  const impl = (context as any).__graphToolExecutor as
    | { executeToolByName: (tc: any, ec: any) => Promise<string> }
    | undefined
  if (!impl) {
    return 'Graph executor is not wired in this runtime. Use plan_graph to validate, and report this as a bug.'
  }
  return runGraph(args, context, impl)
}