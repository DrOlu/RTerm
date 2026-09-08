/**
 * restApi.extreme.spec — parameterized paths, openapi, chat-async, OPTIONS.
 */
export {}

import {
  matchRestRoute,
  defaultRestRoutes,
  handleRestRequest,
  buildOpenApiDocument,
} from './restApi'
import { httpRouteMatches } from './WebSocketGatewayAdapter'

const tests: Array<{ name: string; run: () => Promise<void> | void }> = []
function test(name: string, run: () => Promise<void> | void) {
  tests.push({ name, run })
}
function assertTrue(c: boolean, m: string) {
  if (!c) throw new Error(m)
}

test('httpRouteMatches prefix /api/v1/*', () => {
  assertTrue(httpRouteMatches('/api/v1/*', '/api/v1/health'), 'health')
  assertTrue(httpRouteMatches('/api/v1/*', '/api/v1/terminals/abc/write'), 'write')
  assertTrue(httpRouteMatches('/api/v1/*', '/api/v1'), 'bare')
  assertTrue(!httpRouteMatches('/api/v1/*', '/dashboard'), 'dashboard excluded')
  assertTrue(httpRouteMatches('/dashboard', '/dashboard'), 'exact')
})

test('matchRestRoute parameterized write + buffer', () => {
  const routes = defaultRestRoutes()
  const w = matchRestRoute(routes, 'POST', '/api/v1/terminals/tab-1/write')
  assertTrue(!!w && w.route.gatewayMethod === 'terminal:write', 'write')
  assertTrue(w!.pathParams.id === 'tab-1', 'id')
  const b = matchRestRoute(routes, 'GET', '/api/v1/terminals/tab-1/buffer')
  assertTrue(!!b && b.route.gatewayMethod === 'terminal:getBufferDelta', 'buffer')
})

test('chat-async maps to startTaskAsync', () => {
  const routes = defaultRestRoutes()
  const m = matchRestRoute(routes, 'POST', '/api/v1/sessions/s1/chat-async')
  assertTrue(!!m && m.route.gatewayMethod === 'agent:startTaskAsync', 'async')
})

test('openapi document lists rest paths', () => {
  const doc = buildOpenApiDocument()
  assertTrue(doc.openapi === '3.0.3', 'version')
  const paths = doc.paths as Record<string, unknown>
  assertTrue(!!paths['/api/v1/health'], 'health')
  assertTrue(!!paths['/api/v1/sessions/{id}/chat-async'] || !!paths['/api/v1/sessions/:id/chat-async'], 'async path')
})

test('handleRestRequest openapi does not dispatch', async () => {
  let called = false
  const r = await handleRestRequest(defaultRestRoutes(), async () => {
    called = true
    return {}
  }, { method: 'GET', path: '/api/v1/openapi.json' })
  assertTrue(r.status === 200, '200')
  assertTrue(!called, 'no dispatch')
  assertTrue((r.body as { openapi?: string }).openapi === '3.0.3', 'body')
})

test('handleRestRequest rpc escape hatch', async () => {
  const r = await handleRestRequest(defaultRestRoutes(), async (method, params) => {
    return { method, params }
  }, { method: 'POST', path: '/api/v1/rpc', body: { method: 'gateway:ping', params: {} } })
  assertTrue(r.status === 200, '200')
  assertTrue((r.body as { method: string }).method === 'gateway:ping', 'method')
})

test('OPTIONS short-circuits', async () => {
  const r = await handleRestRequest(defaultRestRoutes(), async () => {
    throw new Error('should not dispatch')
  }, { method: 'OPTIONS', path: '/api/v1/health' })
  assertTrue(r.status === 204, '204')
})

async function main() {
  let pass = 0
  let fail = 0
  for (const t of tests) {
    try {
      await t.run()
      console.log('  ok ', t.name)
      pass++
    } catch (e) {
      console.log('  FAIL', t.name, e instanceof Error ? e.message : e)
      fail++
    }
  }
  console.log(`# tests ${tests.length}`)
  console.log(`# pass ${pass}`)
  console.log(`# fail ${fail}`)
  if (fail) process.exit(1)
}
void main()
