/**
 * agentspan-bridge plugin — run durable, crash-resilient agents + workflows on
 * an AgentSpan (Netflix Conductor) server from RTerm.
 *
 * What this adds that RTerm doesn't already have:
 *   - Durable agent execution: a crashed/restarted run resumes from the last
 *     completed step (Conductor engine), not just a ledger entry.
 *   - Plan-execute determinism (LLM plans once → immutable sub-workflow).
 *   - Enterprise event triggers (Kafka/SQS/AMQP/DB) via the Conductor server.
 *   - A live visual execution UI (served by the AgentSpan server).
 *
 * Config (Settings → agentspan block, resolved here from the RTerm settings
 * service via ctx.settings if present, else env):
 *   serverUrl   — e.g. http://localhost:6767 (default)
 *   authSecretRef — vault key holding "AUTH_KEY=...\nAUTH_SECRET=..." (optional;
 *                   only needed when the AgentSpan server has standalone auth on)
 *
 * The client is dependency-free (conductorClient.mjs) and the plugin never
 * crashes RTerm when the AgentSpan server is down — every tool returns a clear
 * "server unreachable" result instead of throwing.
 */

import { ConductorClient, DEFAULT_BASE_URL, joinUrl } from './conductorClient.mjs'

// ─── config resolution ──────────────────────────────────────────────────────

/** Read the agentspan config block from RTerm settings (ctx.settings) or env. */
export function resolveConfig(ctx = {}, env = process.env) {
  const s = (typeof ctx.getSettings === 'function' ? ctx.getSettings() : ctx.settings) || {}
  const block = s.agentspan || {}
  return {
    serverUrl: (block.serverUrl || env.AGENTSPAN_SERVER_URL || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    authSecretRef: block.authSecretRef || env.AGENTSPAN_AUTH_SECRET_REF || undefined,
    enabled: block.enabled !== false,
  }
}

/** Parse a vault "KEY=VAL" blob into an {key, secret} auth object. */
export function parseAuthBlob(blob) {
  if (!blob || typeof blob !== 'string') return undefined
  const out = {}
  for (const line of blob.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (m) out[m[1]] = m[2].trim()
  }
  const key = out.AGENTSPAN_AUTH_KEY || out.AUTH_KEY || out.KEY
  const secret = out.AGENTSPAN_AUTH_SECRET || out.AUTH_SECRET || out.SECRET
  return key && secret ? { key, secret } : undefined
}

/** Real fetch adapter (matches conductorClient's expected {ok,status,text}). */
async function realFetch(url, init) {
  const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body })
  return { ok: res.ok, status: res.status, text: () => res.text() }
}

/** Build a configured ConductorClient from ctx (settings + vault). */
export function buildClient(ctx = {}, fetchImpl = realFetch) {
  const cfg = resolveConfig(ctx)
  let auth
  if (cfg.authSecretRef && typeof ctx.getSecret === 'function') {
    try {
      const blob = ctx.getSecret(cfg.authSecretRef)
      auth = parseAuthBlob(blob)
    } catch { auth = undefined }
  }
  return { client: new ConductorClient({ baseUrl: cfg.serverUrl, auth, fetchImpl }), config: cfg }
}

// ─── formatting helpers (pure) ─────────────────────────────────────────────

/** Normalize an execution/workflow status payload into a compact summary. */
export function summarizeStatus(payload) {
  if (!payload || typeof payload !== 'object') return { status: 'UNKNOWN' }
  const status = payload.status ?? payload.workflowStatus ?? payload.state ?? 'UNKNOWN'
  const name = payload.workflowName ?? payload.name ?? payload.agentName ?? payload.workflowType
  const id = payload.workflowId ?? payload.executionId ?? payload.id
  const tasks = Array.isArray(payload.tasks) ? payload.tasks : []
  const failed = tasks.filter((t) => String(t.status).toUpperCase().includes('FAIL')).length
  const done = tasks.filter((t) => String(t.status).toUpperCase() === 'COMPLETED').length
  return {
    id,
    name,
    status: String(status).toUpperCase(),
    taskCount: tasks.length,
    completedTasks: done,
    failedTasks: failed,
    startTime: payload.startTime ?? payload.createTime,
    endTime: payload.endTime ?? payload.updateTime,
    reason: payload.reasonForIncompletion ?? payload.failedReason,
  }
}

/** Normalize a search/list result into rows for the panel + agentspan_list. */
export function toExecutionRows(payload) {
  const results = payload?.results ?? payload?.workflows ?? (Array.isArray(payload) ? payload : [])
  if (!Array.isArray(results)) return []
  return results.map((w) => ({
    id: w.workflowId ?? w.executionId ?? w.id,
    name: w.workflowName ?? w.name ?? w.workflowType,
    status: String(w.status ?? w.workflowStatus ?? '').toUpperCase(),
    startTime: w.startTime ?? w.createTime,
    endTime: w.endTime ?? w.updateTime,
  }))
}

/** Map an execution status to a trigger event (fires on FAILED). */
export function isFailedExecution(status) {
  const s = String(status || '').toUpperCase()
  return s === 'FAILED' || s === 'TERMINATED' || s === 'TIMED_OUT'
}

// ─── unreachable-server helper ─────────────────────────────────────────────

async function guarded(fn, log) {
  try {
    return await fn()
  } catch (e) {
    const msg = e?.message ?? String(e)
    log?.(`[agentspan] ${msg}`)
    return { error: msg, hint: 'Is the AgentSpan server running? (agentspan server start, default http://localhost:6767). Configure the URL in Settings → agentspan.' }
  }
}

// ─── plugin entry ───────────────────────────────────────────────────────────

export function register(ctx) {
  const { registerTool, registerTrigger, registerPanel, log } = ctx
  const { client, config } = buildClient(ctx)

  // Tool: agentspan_health — check the server is reachable + its status.
  registerTool({
    name: 'agentspan_health',
    description: 'Check whether the AgentSpan/Conductor server is reachable and healthy. Returns the server URL, health status, and whether auth is configured.',
    params: {},
    handler: async () => guarded(async () => {
      const h = await client.health()
      if (!h.ok) {
        return {
          serverUrl: config.serverUrl,
          authConfigured: Boolean(config.authSecretRef),
          ...h,
          hint: 'Is the AgentSpan server running? (agentspan server start, default http://localhost:6767). Configure the URL in Settings → agentspan.',
        }
      }
      return { serverUrl: config.serverUrl, authConfigured: Boolean(config.authSecretRef), ...h }
    }, log),
  })

  // Tool: agentspan_run — run a durable agent (AgentConfig) or named workflow.
  registerTool({
    name: 'agentspan_run',
    description: 'Start a durable, crash-resilient agent or workflow on the AgentSpan server. Pass either an `agentConfig` (compiled+started via /api/agent/start) or a `workflow` name (Conductor /api/workflow/{name}). Returns the executionId/workflowId — the run survives process restarts and resumes from the last completed step.',
    params: {
      agentConfig: { type: 'object', description: 'An AgentConfig JSON (agent tree) to compile+run durably', optional: true },
      workflow: { type: 'string', description: 'Name of a registered Conductor workflow to start', optional: true },
      input: { type: 'object', description: 'Input payload for the agent/workflow', optional: true },
      prompt: { type: 'string', description: 'Natural-language prompt for the agent', optional: true },
    },
    handler: async (p) => guarded(async () => {
      if (p?.agentConfig) {
        const r = await client.runAgent(p.agentConfig, p.prompt ?? p.input)
        return { kind: 'agent', executionId: r.executionId, serverUrl: config.serverUrl, uiUrl: joinUrl(config.serverUrl, `/execution/${r.executionId}`), raw: r.raw }
      }
      if (p?.workflow) {
        const id = await client.startWorkflow(p.workflow, p.input ?? {})
        return { kind: 'workflow', workflowId: id, serverUrl: config.serverUrl, uiUrl: joinUrl(config.serverUrl, `/execution/${id}`) }
      }
      return { error: 'agentspan_run needs either agentConfig or workflow' }
    }, log),
  })

  // Tool: agentspan_status — detailed status of an execution/workflow.
  registerTool({
    name: 'agentspan_status',
    description: 'Get the detailed status of a durable execution (agent or workflow) by id — current status, per-task progress, failed tasks, and failure reason if any.',
    params: { executionId: { type: 'string', description: 'The executionId or workflowId' } },
    handler: async (p) => guarded(async () => {
      if (!p?.executionId) return { error: 'agentspan_status needs executionId' }
      // Try the agent lifecycle surface first, fall back to the workflow engine.
      try {
        const a = await client.agentStatus(p.executionId)
        return { kind: 'agent', ...summarizeStatus(a), raw: a }
      } catch {
        const w = await client.getWorkflow(p.executionId)
        return { kind: 'workflow', ...summarizeStatus(w) }
      }
    }, log),
  })

  // Tool: agentspan_approve — human-in-the-loop respond to a paused HUMAN task.
  registerTool({
    name: 'agentspan_approve',
    description: 'Respond to a paused human-in-the-loop task in a durable execution (completes the HUMAN task and resumes the run). Pass the executionId and an `output` object (e.g. {approved:true, comment:"..."}).',
    params: {
      executionId: { type: 'string', description: 'The executionId with a paused HUMAN task' },
      output: { type: 'object', description: 'The response output map (e.g. {approved:true})' },
    },
    handler: async (p) => guarded(async () => {
      if (!p?.executionId) return { error: 'agentspan_approve needs executionId' }
      await client.agentRespond(p.executionId, p.output ?? {})
      const s = await client.agentStatus(p.executionId).catch(() => null)
      return { responded: true, executionId: p.executionId, ...(s ? summarizeStatus(s) : {}) }
    }, log),
  })

  // Tool: agentspan_list — list recent executions (optionally filtered).
  registerTool({
    name: 'agentspan_list',
    description: 'List recent durable executions on the AgentSpan server. Optional `query` (Conductor freeText, e.g. "status:FAILED" or "workflowName:cleanup") and `size`. Returns id/name/status/start/end rows.',
    params: {
      query: { type: 'string', description: 'Conductor freeText query (default *)', optional: true },
      size: { type: 'number', description: 'Max results (default 20)', optional: true },
    },
    handler: async (p) => guarded(async () => {
      const r = await client.searchWorkflows(p?.query ?? '*', p?.size ?? 20)
      const rows = toExecutionRows(r)
      return { count: rows.length, executions: rows }
    }, log),
  })

  // Tool: agentspan_stop — terminate a running execution.
  registerTool({
    name: 'agentspan_stop',
    description: 'Stop (terminate) a running durable execution by id. Optionally pass a `reason`.',
    params: {
      executionId: { type: 'string', description: 'The executionId/workflowId to stop' },
      reason: { type: 'string', description: 'Optional termination reason', optional: true },
    },
    handler: async (p) => guarded(async () => {
      if (!p?.executionId) return { error: 'agentspan_stop needs executionId' }
      try {
        await client.agentStop(p.executionId)
      } catch {
        await client.terminateWorkflow(p.executionId, p.reason)
      }
      return { stopped: true, executionId: p.executionId }
    }, log),
  })

  // Trigger: agentspan_execution_failed — fires when a durable execution fails.
  registerTrigger({
    name: 'agentspan_execution_failed',
    description: 'Fires when an AgentSpan/Conductor durable execution transitions to FAILED/TERMINATED/TIMED_OUT. Use for auto-remediation or re-run playbooks.',
    match: (event) => {
      if (event?.source !== 'agentspan') return false
      return isFailedExecution(event.status)
    },
    action: 'propose-change',
  })

  // Panel: agentspan-executions — live feed of durable executions.
  registerPanel({
    name: 'agentspan-executions',
    title: 'AgentSpan Executions',
    render: (data) => {
      const rows = (Array.isArray(data) ? data : []).map((e) =>
        `<tr><td>${e.name ?? ''}</td><td>${e.id ?? ''}</td><td>${e.status ?? ''}</td><td>${e.startTime ?? ''}</td></tr>`
      ).join('')
      return `<div class="agentspan-executions"><h3>AgentSpan Durable Executions</h3><p>Server: ${config.serverUrl}</p><table><thead><tr><th>Name</th><th>Execution</th><th>Status</th><th>Started</th></tr></thead><tbody>${rows}</tbody></table></div>`
    },
  })

  log(`[agentspan] agentspan-bridge registered: 6 tools, 1 trigger, 1 panel (server=${config.serverUrl})`)
}

export default {
  register,
  resolveConfig,
  parseAuthBlob,
  buildClient,
  summarizeStatus,
  toExecutionRows,
  isFailedExecution,
}
