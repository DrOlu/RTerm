/**
 * restApi — HTTP overlay on the WebSocket JSON-RPC gateway.
 *
 * Real product API remains WS JSON-RPC. This layer is for curl / CI / OpenAPI
 * clients. Parameterized paths work when the HTTP server uses prefix match
 * (`/api/v1/*`) plus matchRestRoute (see httpRouteMatches).
 *
 *   GET  /api/v1/health
 *   GET  /api/v1/methods
 *   GET  /api/v1/openapi.json
 *   GET  /api/v1/terminals
 *   POST /api/v1/terminals/:id/write
 *   GET  /api/v1/terminals/:id/buffer
 *   GET  /api/v1/sessions
 *   POST /api/v1/sessions                     → gateway:createSession
 *   POST /api/v1/sessions/:id/chat            → agent:startTask (blocking)
 *   POST /api/v1/sessions/:id/chat-async      → agent:startTaskAsync
 *   GET  /api/v1/skills
 *   GET  /api/v1/observability/metrics|dashboard|apm
 *   GET  /api/v1/history/search?q=
 *   POST /api/v1/rpc                          → any gateway method
 */

import { CORE_METHODS, DESCRIBE_METHOD, METHOD_CATEGORIES } from './methodRegistry'

export interface RestRoute {
  method: 'GET' | 'POST'
  path: string
  gatewayMethod: string
  buildParams?: (pathParams: Record<string, string>, body: unknown) => Record<string, unknown>
  description: string
}

export interface RestMatch {
  route: RestRoute
  pathParams: Record<string, string>
}

export function matchRestRoute(
  routes: readonly RestRoute[],
  method: string,
  path: string,
): RestMatch | null {
  const normalized = path.replace(/\/+$/, '') || '/'
  const verb = method.toUpperCase()
  for (const route of routes) {
    if (route.method !== verb) continue
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

export function defaultRestRoutes(): RestRoute[] {
  return [
    { method: 'GET', path: '/api/v1/health', gatewayMethod: 'gateway:ping', description: 'Liveness check' },
    { method: 'GET', path: '/api/v1/methods', gatewayMethod: 'gateway:describe', description: 'List all gateway RPC methods' },
    { method: 'GET', path: '/api/v1/openapi.json', gatewayMethod: '__openapi', description: 'OpenAPI 3 document for this REST overlay + RPC escape hatch' },
    { method: 'GET', path: '/api/v1/terminals', gatewayMethod: 'terminal:list', description: 'List terminal tabs' },
    { method: 'GET', path: '/api/v1/sessions', gatewayMethod: 'session:list', description: 'List chat sessions' },
    {
      method: 'POST',
      path: '/api/v1/sessions',
      gatewayMethod: 'gateway:createSession',
      description: 'Create a chat/agent session',
    },
    { method: 'GET', path: '/api/v1/skills', gatewayMethod: 'skills:getAll', description: 'List loaded skills' },
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
      description: 'APM summary',
    },
    {
      method: 'GET',
      path: '/api/v1/history/search',
      gatewayMethod: 'history:search',
      description: 'Cross-session history search (?q=)',
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
      description: 'Read terminal output delta (?fromOffset=)',
      buildParams: (p, body) => {
        const b = (body ?? {}) as { fromOffset?: number | string }
        const n = Number(b.fromOffset ?? 0)
        return { terminalId: p.id, fromOffset: Number.isFinite(n) ? n : 0 }
      },
    },
    {
      method: 'POST',
      path: '/api/v1/sessions/:id/chat',
      gatewayMethod: 'agent:startTask',
      description: 'Send a message (blocking until the run finishes — prefer chat-async)',
      buildParams: (p, body) => {
        const b = (body ?? {}) as { message?: string; userInput?: string }
        return { sessionId: p.id, userInput: b.message ?? b.userInput ?? '' }
      },
    },
    {
      method: 'POST',
      path: '/api/v1/sessions/:id/chat-async',
      gatewayMethod: 'agent:startTaskAsync',
      description: 'Start an agent turn without waiting; subscribe to WS gateway:event for tokens',
      buildParams: (p, body) => {
        const b = (body ?? {}) as { message?: string; userInput?: string }
        return { sessionId: p.id, userInput: b.message ?? b.userInput ?? '' }
      },
    },
    {
      method: 'POST',
      path: '/api/v1/rpc',
      gatewayMethod: '',
      description: 'Escape hatch: any gateway method {method, params}',
    },
  ]
}

export interface RestDispatchResult {
  status: number
  body: unknown
  headers?: Record<string, string>
}

export function buildOpenApiDocument(): Record<string, unknown> {
  const routes = defaultRestRoutes()
  const paths: Record<string, unknown> = {}
  for (const r of routes) {
    if (r.gatewayMethod === '__openapi') continue
    const item = (paths[r.path] as Record<string, unknown>) || {}
    item[r.method.toLowerCase()] = {
      summary: r.description,
      operationId: `${r.method}_${r.path.replace(/[^a-zA-Z0-9]+/g, '_')}`,
      tags: ['rest'],
      ...(r.method === 'POST'
        ? {
            requestBody: {
              content: { 'application/json': { schema: { type: 'object' } } },
            },
          }
        : {}),
      responses: { '200': { description: 'OK' }, '401': { description: 'Unauthorized' } },
    }
    paths[r.path] = item
  }
  const rpcMethods = [...CORE_METHODS, DESCRIBE_METHOD].map((m) => m.name)
  return {
    openapi: '3.0.3',
    info: {
      title: 'RTerm HTTP overlay',
      version: '1.0.0',
      description:
        'Thin REST on the same port as the WebSocket JSON-RPC gateway. ' +
        'Streaming agent/PTY traffic stays on ws://. POST /api/v1/rpc reaches every RPC method. ' +
        `Core RPC methods: ${rpcMethods.length}. Categories: ${METHOD_CATEGORIES.join(', ')}.`,
    },
    paths,
    'x-gateway-rpc-methods': rpcMethods,
  }
}

export async function handleRestRequest(
  routes: readonly RestRoute[],
  dispatch: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  req: { method: string; path: string; body?: unknown },
): Promise<RestDispatchResult> {
  const verb = req.method.toUpperCase()
  if (verb === 'OPTIONS') {
    return {
      status: 204,
      body: '',
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'Authorization, Content-Type',
      },
    }
  }

  const match = matchRestRoute(routes, req.method, req.path)
  if (!match) {
    return {
      status: 404,
      body: { error: 'not_found', message: `No REST route for ${req.method} ${req.path}` },
    }
  }

  if (match.route.gatewayMethod === '__openapi') {
    return { status: 200, body: buildOpenApiDocument() }
  }

  let gatewayMethod = match.route.gatewayMethod
  let params: Record<string, unknown>
  if (gatewayMethod === '') {
    const raw = (req.body ?? {}) as { method?: string; params?: Record<string, unknown> }
    if (!raw.method) {
      return {
        status: 400,
        body: { error: 'bad_request', message: 'POST /api/v1/rpc needs {"method": "...", "params": {...}}' },
      }
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
    const status = /not found|no terminal|no session|no playbook/i.test(message)
      ? 404
      : /invalid|bad request|must be|requires/i.test(message)
        ? 400
        : 500
    return { status, body: { error: 'gateway_error', message } }
  }
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }

function readJsonBody(req: { on?: (e: string, cb: (d?: Buffer) => void) => void }): Promise<unknown> {
  return new Promise((resolve) => {
    let data = ''
    req.on?.('data', (d) => {
      data += String(d ?? '')
      if (data.length > 2_000_000) {
        resolve({})
      }
    })
    req.on?.('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {})
      } catch {
        resolve({})
      }
    })
  })
}

/**
 * One HTTP handler for `/api/v1/*` (prefix match in the adapter).
 */
export function makeRestCatchAllHandler(opts: {
  isAuthorized: (req: unknown) => Promise<boolean>
  dispatch: (method: string, params: Record<string, unknown>) => Promise<unknown>
}): (req: unknown, res: unknown) => Promise<void> {
  const routes = defaultRestRoutes()
  return async (req: unknown, res: unknown): Promise<void> => {
    const r = req as { method?: string; url?: string }
    const s = res as {
      writeHead?: (n: number, h: Record<string, string>) => void
      end?: (b?: string) => void
    }
    try {
      if (!(await opts.isAuthorized(r))) {
        s.writeHead?.(401, JSON_HEADERS)
        s.end?.(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      const url = new URL(r.url ?? '/', 'http://localhost')
      const body =
        r.method === 'POST' || r.method === 'PUT'
          ? await readJsonBody(r as never)
          : Object.fromEntries(url.searchParams.entries())
      const result = await handleRestRequest(routes, opts.dispatch, {
        method: r.method ?? 'GET',
        path: url.pathname,
        body,
      })
      s.writeHead?.(result.status, { ...JSON_HEADERS, ...(result.headers ?? {}) })
      if (result.body === '' || result.body === undefined) s.end?.()
      else s.end?.(typeof result.body === 'string' ? result.body : JSON.stringify(result.body))
    } catch (e) {
      s.writeHead?.(500, JSON_HEADERS)
      s.end?.(JSON.stringify({ error: 'internal', message: e instanceof Error ? e.message : String(e) }))
    }
  }
}
