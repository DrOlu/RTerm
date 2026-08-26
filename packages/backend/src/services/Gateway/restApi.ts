/**
 * restApi — a thin REST layer over the gateway's method registry (v3.2.18).
 *
 * The gateway speaks WebSocket JSON-RPC; this module adds plain-HTTP routes so
 * curl / CI / monitoring tools can drive RTerm without a WS client:
 *
 *   GET  /api/v1/methods                    → gateway:describe
 *   GET  /api/v1/terminals                  → terminal:list
 *   POST /api/v1/terminals/:id/exec         → terminal:write + buffer read
 *   GET  /api/v1/sessions                   → session:list
 *   POST /api/v1/sessions/:id/chat          → agent:startTask
 *   GET  /api/v1/observability/metrics      → observability:metricsPrometheus
 *   GET  /api/v1/health                     → gateway:ping
 *   POST /api/v1/rpc                        → any method (escape hatch)
 *
 * Pure: route matching and response shaping are testable without a server.
 * The caller wires `dispatch(method, params)` to the existing gateway.
 */

export interface RestRoute {
  /** HTTP method */
  method: 'GET' | 'POST'
  /** path pattern, e.g. "/api/v1/terminals/:id/exec" */
  path: string
  /** gateway method to dispatch to */
  gatewayMethod: string
  /** build gateway params from the path params + body */
  buildParams?: (pathParams: Record<string, string>, body: unknown) => Record<string, unknown>
  /** human description */
  description: string
}

export interface RestMatch {
  route: RestRoute
  pathParams: Record<string, string>
}

/** Match a concrete request path+method against the route table. */
export function matchRestRoute(
  routes: readonly RestRoute[],
  method: string,
  path: string,
): RestMatch | null {
  const normalized = path.replace(/\/+$/, '') || '/'
  for (const route of routes) {
    if (route.method !== method.toUpperCase()) continue
    const patternParts = route.path.split('/').filter(Boolean)
    const pathParts = normalized.split('/').filter(Boolean)
    if (patternParts.length !== pathParts.length) continue
    const params: Record<string, string> = {}
    let matched = true
    for (let i = 0; i < patternParts.length; i++) {
      const p = patternParts[i]
      if (p.startsWith(':')) {
        params[p.slice(1)] = decodeURIComponent(pathParts[i])
      } else if (p !== pathParts[i]) {
        matched = false
        break
      }
    }
    if (matched) return { route, pathParams: params }
  }
  return null
}

/** The default route table. */
export function defaultRestRoutes(): RestRoute[] {
  return [
    {
      method: 'GET',
      path: '/api/v1/health',
      gatewayMethod: 'gateway:ping',
      description: 'Liveness check',
    },
    {
      method: 'GET',
      path: '/api/v1/methods',
      gatewayMethod: 'gateway:describe',
      description: 'List all gateway methods (self-describing)',
    },
    {
      method: 'GET',
      path: '/api/v1/terminals',
      gatewayMethod: 'terminal:list',
      description: 'List terminal tabs',
    },
    {
      method: 'GET',
      path: '/api/v1/sessions',
      gatewayMethod: 'session:list',
      description: 'List chat sessions',
    },
    {
      method: 'GET',
      path: '/api/v1/skills',
      gatewayMethod: 'skills:getAll',
      description: 'List loaded skills',
    },
    {
      method: 'GET',
      path: '/api/v1/observability/metrics',
      gatewayMethod: 'observability:metricsPrometheus',
      description: 'Host metrics (Prometheus text or summary)',
    },
    {
      method: 'GET',
      path: '/api/v1/observability/dashboard',
      gatewayMethod: 'observability:liveDashboardState',
      description: 'Live dashboard state',
    },
    {
      method: 'GET',
      path: '/api/v1/observability/apm',
      gatewayMethod: 'observability:apmSummary',
      description: 'APM summary (LLM + app traces)',
    },
    {
      method: 'GET',
      path: '/api/v1/history/search',
      gatewayMethod: 'history:search',
      description: 'Cross-session history search (?q=...)',
      buildParams: (_p, body) => {
        const b = (body ?? {}) as { q?: string; query?: string }
        return { query: b.q ?? b.query ?? '' }
      },
    },
    {
      method: 'POST',
      path: '/api/v1/terminals/:id/write',
      gatewayMethod: 'terminal:write',
      description: 'Write data to a terminal tab',
      buildParams: (p, body) => {
        const b = (body ?? {}) as { data?: string }
        return { terminalId: p.id, data: b.data ?? '' }
      },
    },
    {
      method: 'GET',
      path: '/api/v1/terminals/:id/buffer',
      gatewayMethod: 'terminal:getBufferDelta',
      description: 'Read a terminal tab output delta',
      buildParams: (p, body) => {
        const b = (body ?? {}) as { fromOffset?: number }
        return { terminalId: p.id, fromOffset: b.fromOffset ?? 0 }
      },
    },
    {
      method: 'POST',
      path: '/api/v1/sessions/:id/chat',
      gatewayMethod: 'agent:startTask',
      description: 'Send a message to the agent (blocking)',
      buildParams: (p, body) => {
        const b = (body ?? {}) as { message?: string; userInput?: string }
        return { sessionId: p.id, userInput: b.message ?? b.userInput ?? '' }
      },
    },
    {
      method: 'POST',
      path: '/api/v1/rpc',
      gatewayMethod: '',
      description: 'Escape hatch: dispatch any gateway method',
      buildParams: (_p, body) => {
        const b = (body ?? {}) as { method?: string; params?: Record<string, unknown> }
        return { __rpcMethod: b.method ?? '', ...(b.params ?? {}) }
      },
    },
  ]
}

export interface RestDispatchResult {
  status: number
  body: unknown
}

/**
 * Handle one REST request. Pure: the caller injects the dispatch function.
 */
export async function handleRestRequest(
  routes: readonly RestRoute[],
  dispatch: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  req: { method: string; path: string; body?: unknown },
): Promise<RestDispatchResult> {
  const match = matchRestRoute(routes, req.method, req.path)
  if (!match) {
    return {
      status: 404,
      body: { error: 'not_found', message: `No REST route for ${req.method} ${req.path}` },
    }
  }

  // The /rpc escape hatch carries its method in the body.
  let gatewayMethod = match.route.gatewayMethod
  let params: Record<string, unknown>
  if (gatewayMethod === '') {
    const raw = (req.body ?? {}) as { method?: string; params?: Record<string, unknown> }
    if (!raw.method) {
      return { status: 400, body: { error: 'bad_request', message: 'POST /api/v1/rpc needs {"method": "...", "params": {...}}' } }
    }
    gatewayMethod = raw.method
    params = raw.params ?? {}
  } else {
    params = match.route.buildParams?.(match.pathParams, req.body) ?? match.pathParams
  }

  try {
    const result = await dispatch(gatewayMethod, params)
    return { status: 200, body: result ?? { ok: true } }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const status = /not found|no terminal|no session|no playbook/i.test(message) ? 404
      : /invalid|bad request|must be|requires/i.test(message) ? 400
      : 500
    return { status, body: { error: 'gateway_error', message } }
  }
}
