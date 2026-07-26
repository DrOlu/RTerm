/**
 * conductorClient.mjs — a minimal, dependency-free HTTP client for the
 * AgentSpan / Netflix-Conductor REST API.
 *
 * AgentSpan server runs on Conductor (default http://localhost:6767) and
 * exposes both its own `/api/agent/*` lifecycle surface and Conductor's
 * `/api/workflow/*` engine surface. This client is pure + injectable (a
 * `fetchImpl` is passed in) so it is fully unit-testable offline and has no
 * runtime network dependency baked in — the plugin wires the real `fetch`.
 *
 * Auth: AgentSpan standalone auth uses X-Auth-Key / X-Auth-Secret headers
 * (AGENTSPAN_AUTH_KEY / AGENTSPAN_AUTH_SECRET). Conductor OSS uses no auth by
 * default. The client sends the headers only when both are provided.
 */

export const DEFAULT_BASE_URL = 'http://localhost:6767'

/** Build the auth headers for a request (only when both key+secret are set). */
export function authHeaders(auth) {
  const h = { 'content-type': 'application/json', accept: 'application/json' }
  if (auth && auth.key && auth.secret) {
    h['X-Auth-Key'] = auth.key
    h['X-Auth-Secret'] = auth.secret
  }
  return h
}

/** Join a base URL + path safely (single slash). */
export function joinUrl(base, path) {
  const b = String(base || DEFAULT_BASE_URL).replace(/\/+$/, '')
  const p = String(path || '').startsWith('/') ? String(path) : `/${path}`
  return `${b}${p}`
}

/** Parse a response body as JSON when possible, else return raw text. */
async function parseBody(res) {
  const text = await res.text()
  if (!text) return null
  try { return JSON.parse(text) } catch { return text }
}

export class ConductorApiError extends Error {
  constructor(status, path, body) {
    super(`conductor ${status} ${path}: ${typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body)?.slice(0, 300)}`)
    this.status = status
    this.path = path
    this.body = body
  }
}

export class ConductorClient {
  /**
   * @param {{ baseUrl?: string, auth?: {key?:string, secret?:string}, fetchImpl: Function }} opts
   *   fetchImpl(url, {method, headers, body}) -> Promise<{ok,status,text:()=>Promise<string>}>
   */
  constructor(opts = {}) {
    if (typeof opts.fetchImpl !== 'function') throw new Error('ConductorClient needs a fetchImpl')
    this.baseUrl = opts.baseUrl || DEFAULT_BASE_URL
    this.auth = opts.auth
    this.fetchImpl = opts.fetchImpl
  }

  async request(method, path, body) {
    const url = joinUrl(this.baseUrl, path)
    const res = await this.fetchImpl(url, {
      method,
      headers: authHeaders(this.auth),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const parsed = await parseBody(res)
    if (!res.ok) throw new ConductorApiError(res.status, `${method} ${path}`, parsed)
    return parsed
  }

  // ── Health ────────────────────────────────────────────────────────────────
  /** AgentSpan/Conductor health (Spring Actuator). */
  async health() {
    try {
      const r = await this.request('GET', '/actuator/health')
      return { ok: true, status: r?.status ?? 'UP', raw: r }
    } catch (e) {
      return { ok: false, status: 'DOWN', error: e.message }
    }
  }

  // ── Agent lifecycle (AgentSpan /api/agent) ───────────────────────────────
  /** Compile + register + start an agent from an AgentConfig; returns { executionId }. */
  async runAgent(agentConfig, prompt) {
    const body = prompt !== undefined ? { agent: agentConfig, input: prompt } : agentConfig
    const r = await this.request('POST', '/api/agent/start', body)
    return { executionId: r?.executionId ?? r?.workflowId ?? r?.id ?? null, raw: r }
  }

  /** Compile only (returns the WorkflowDef without executing). */
  async compileAgent(agentConfig) {
    return this.request('POST', '/api/agent/compile', agentConfig)
  }

  /** Detailed status of a running/finished execution. */
  async agentStatus(executionId) {
    if (!executionId) throw new Error('agentStatus needs an executionId')
    return this.request('GET', `/api/agent/${encodeURIComponent(executionId)}`)
  }

  /** Human-in-the-loop respond: complete a paused HUMAN task + resume. */
  async agentRespond(executionId, output) {
    if (!executionId) throw new Error('agentRespond needs an executionId')
    return this.request('POST', `/api/agent/${encodeURIComponent(executionId)}/respond`, output ?? {})
  }

  /** Stop (cancel) an execution. */
  async agentStop(executionId) {
    if (!executionId) throw new Error('agentStop needs an executionId')
    return this.request('POST', `/api/agent/${encodeURIComponent(executionId)}/stop`, {})
  }

  /** Server-sent event log for an execution. */
  async agentEvents(executionId) {
    if (!executionId) throw new Error('agentEvents needs an executionId')
    return this.request('GET', `/api/agent/events/${encodeURIComponent(executionId)}`)
  }

  /** List agent definitions registered on the server. */
  async listAgentDefinitions() {
    return this.request('GET', '/api/agent/definitions')
  }

  // ── Workflow engine (Conductor /api/workflow) ────────────────────────────
  /** Start a named Conductor workflow; returns the workflowId string. */
  async startWorkflow(name, input, opts = {}) {
    if (!name) throw new Error('startWorkflow needs a workflow name')
    const q = new URLSearchParams()
    if (opts.version !== undefined) q.set('version', String(opts.version))
    if (opts.correlationId) q.set('correlationId', String(opts.correlationId))
    const path = `/api/workflow/${encodeURIComponent(name)}${q.size ? `?${q}` : ''}`
    const r = await this.request('POST', path, input ?? {})
    return typeof r === 'string' ? r : (r?.workflowId ?? r?.id ?? null)
  }

  /** Get a workflow execution (status + tasks). */
  async getWorkflow(workflowId, includeTasks = true) {
    if (!workflowId) throw new Error('getWorkflow needs a workflowId')
    return this.request('GET', `/api/workflow/${encodeURIComponent(workflowId)}?includeTasks=${includeTasks}`)
  }

  /** Terminate a workflow execution. */
  async terminateWorkflow(workflowId, reason) {
    if (!workflowId) throw new Error('terminateWorkflow needs a workflowId')
    const q = reason ? `?reason=${encodeURIComponent(reason)}` : ''
    return this.request('DELETE', `/api/workflow/${encodeURIComponent(workflowId)}${q}`)
  }

  /** Retry a failed workflow from the last failed task (durable resume). */
  async retryWorkflow(workflowId) {
    if (!workflowId) throw new Error('retryWorkflow needs a workflowId')
    return this.request('POST', `/api/workflow/${encodeURIComponent(workflowId)}/retry`, {})
  }

  /** Search workflow executions (freeText query, e.g. status:FAILED). */
  async searchWorkflows(query = '*', size = 20) {
    const q = new URLSearchParams({ freeText: query, size: String(size), sort: 'startTime:DESC' })
    return this.request('GET', `/api/workflow/search?${q}`)
  }
}

export default ConductorClient
