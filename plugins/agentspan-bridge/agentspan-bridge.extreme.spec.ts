/**
 * agentspan-bridge.extreme.spec.ts — exhaustive offline tests for the
 * AgentSpan/Conductor bridge: the dependency-free HTTP client (URL building,
 * auth headers, error mapping, every endpoint) and the plugin glue (config
 * resolution, auth blob parsing, status/row normalization, tool wiring,
 * unreachable-server resilience, trigger match). No network — fetch is mocked.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ConductorClient, ConductorApiError, authHeaders, joinUrl, DEFAULT_BASE_URL } from './conductorClient.mjs'
import {
  register,
  resolveConfig,
  parseAuthBlob,
  buildClient,
  summarizeStatus,
  toExecutionRows,
  isFailedExecution,
} from './index.mjs'

// ─── mock fetch ─────────────────────────────────────────────────────────────
/** A scriptable fetch mock: records calls, returns queued/mapped responses. */
function mockFetch(respond) {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url, init })
    const r = typeof respond === 'function' ? respond(url, init, calls.length) : respond
    return { ok: r.ok !== false && (r.status ?? 200) < 400, status: r.status ?? 200, text: async () => r.text ?? (r.json !== undefined ? JSON.stringify(r.json) : '') }
  }
  fn.calls = calls
  return fn
}

// ─── conductorClient: URL + auth header building ───────────────────────────
test('joinUrl joins base+path with a single slash', () => {
  assert.equal(joinUrl('http://h:6767/', '/api/agent/start'), 'http://h:6767/api/agent/start')
  assert.equal(joinUrl('http://h:6767', 'api/agent/start'), 'http://h:6767/api/agent/start')
  assert.equal(joinUrl(undefined, '/x'), `${DEFAULT_BASE_URL}/x`)
})

test('authHeaders only sends X-Auth-* when both key+secret present', () => {
  assert.deepEqual(authHeaders(undefined), { 'content-type': 'application/json', accept: 'application/json' })
  assert.deepEqual(authHeaders({ key: 'k' }), { 'content-type': 'application/json', accept: 'application/json' })
  const h = authHeaders({ key: 'k', secret: 's' })
  assert.equal(h['X-Auth-Key'], 'k')
  assert.equal(h['X-Auth-Secret'], 's')
})

test('ConductorClient requires a fetchImpl', () => {
  assert.throws(() => new ConductorClient({}), /fetchImpl/)
})

// ─── conductorClient: endpoints ────────────────────────────────────────────
test('health() maps actuator health to {ok,status} and never throws', async () => {
  const up = new ConductorClient({ fetchImpl: mockFetch({ json: { status: 'UP' } }) })
  assert.deepEqual(await up.health(), { ok: true, status: 'UP', raw: { status: 'UP' } })
  const down = new ConductorClient({ fetchImpl: mockFetch(() => { throw new Error('ECONNREFUSED') }) })
  const h = await down.health()
  assert.equal(h.ok, false)
  assert.equal(h.status, 'DOWN')
  assert.match(h.error, /ECONNREFUSED/)
})

test('runAgent posts to /api/agent/start and extracts executionId', async () => {
  const f = mockFetch({ json: { executionId: 'exec-123' } })
  const c = new ConductorClient({ fetchImpl: f })
  const r = await c.runAgent({ name: 'a' }, 'hello')
  assert.equal(r.executionId, 'exec-123')
  const call = f.calls[0]
  assert.equal(call.url, `${DEFAULT_BASE_URL}/api/agent/start`)
  assert.equal(call.init.method, 'POST')
  const body = JSON.parse(call.init.body)
  assert.deepEqual(body.agent, { name: 'a' })
  assert.equal(body.input, 'hello')
})

test('runAgent falls back to workflowId/id when executionId absent', async () => {
  const c = new ConductorClient({ fetchImpl: mockFetch({ json: { workflowId: 'wf-9' } }) })
  assert.equal((await c.runAgent({ name: 'a' })).executionId, 'wf-9')
})

test('agentStatus/Respond/Stop hit the lifecycle endpoints + require id', async () => {
  const f = mockFetch({ json: { status: 'RUNNING' } })
  const c = new ConductorClient({ fetchImpl: f })
  await assert.rejects(() => c.agentStatus(), /executionId/)
  await c.agentStatus('e1')
  await c.agentRespond('e1', { approved: true })
  await c.agentStop('e1')
  const urls = f.calls.map((x) => `${x.init.method} ${x.url}`)
  assert.ok(urls.includes(`GET ${DEFAULT_BASE_URL}/api/agent/e1`))
  assert.ok(urls.includes(`POST ${DEFAULT_BASE_URL}/api/agent/e1/respond`))
  assert.ok(urls.includes(`POST ${DEFAULT_BASE_URL}/api/agent/e1/stop`))
})

test('startWorkflow builds the right path + returns the id string', async () => {
  const f = mockFetch({ text: 'wf-abc' })
  const c = new ConductorClient({ fetchImpl: f })
  const id = await c.startWorkflow('cleanup', { host: 'web-1' }, { version: 3 })
  assert.equal(id, 'wf-abc')
  assert.match(f.calls[0].url, /\/api\/workflow\/cleanup\?version=3$/)
})

test('getWorkflow/terminate/retry/search hit the engine surface', async () => {
  const f = mockFetch({ json: { results: [] } })
  const c = new ConductorClient({ fetchImpl: f })
  await c.getWorkflow('w1')
  await c.terminateWorkflow('w1', 'done')
  await c.retryWorkflow('w1')
  await c.searchWorkflows('status:FAILED', 5)
  const urls = f.calls.map((x) => `${x.init.method} ${x.url}`)
  assert.ok(urls.some((u) => u.startsWith(`GET ${DEFAULT_BASE_URL}/api/workflow/w1?includeTasks=`)))
  assert.ok(urls.some((u) => u.startsWith(`DELETE ${DEFAULT_BASE_URL}/api/workflow/w1?reason=done`)))
  assert.ok(urls.includes(`POST ${DEFAULT_BASE_URL}/api/workflow/w1/retry`))
  assert.ok(urls.some((u) => u.includes('/api/workflow/search?') && u.includes('status%3AFAILED')))
})

test('non-2xx responses raise ConductorApiError with status + body', async () => {
  // health() swallows errors into {ok:false}; other methods raise ConductorApiError.
  const up = new ConductorClient({ fetchImpl: mockFetch({ ok: false, status: 500, text: 'boom' }) })
  const h = await up.health()
  assert.equal(h.ok, false)
  const c2 = new ConductorClient({ fetchImpl: mockFetch({ ok: false, status: 500, text: 'boom' }) })
  await assert.rejects(() => c2.getWorkflow('w1'), ConductorApiError)
  const c3 = new ConductorClient({ fetchImpl: mockFetch({ ok: false, status: 404, text: 'nope' }) })
  await assert.rejects(() => c3.agentStatus('x'), ConductorApiError)
})

// ─── plugin glue: config + auth ────────────────────────────────────────────
test('resolveConfig prefers settings, falls back to env, strips trailing slash', () => {
  const c = resolveConfig({ settings: { agentspan: { serverUrl: 'http://srv:6767/', authSecretRef: 'as-auth' } } }, {})
  assert.equal(c.serverUrl, 'http://srv:6767')
  assert.equal(c.authSecretRef, 'as-auth')
  const env = resolveConfig({}, { AGENTSPAN_SERVER_URL: 'http://env:6767/' })
  assert.equal(env.serverUrl, 'http://env:6767')
  assert.equal(resolveConfig({}, {}).serverUrl, DEFAULT_BASE_URL)
})

test('parseAuthBlob parses KEY=VAL lines into {key,secret}', () => {
  assert.deepEqual(parseAuthBlob('AGENTSPAN_AUTH_KEY=k\nAGENTSPAN_AUTH_SECRET=s'), { key: 'k', secret: 's' })
  assert.deepEqual(parseAuthBlob('AUTH_KEY=a\nAUTH_SECRET=b'), { key: 'a', secret: 'b' })
  assert.equal(parseAuthBlob('AGENTSPAN_AUTH_KEY=only'), undefined)
  assert.equal(parseAuthBlob(''), undefined)
  assert.equal(parseAuthBlob(undefined), undefined)
})

test('buildClient wires auth from ctx.getSecret + configures baseUrl', () => {
  const ctx = {
    settings: { agentspan: { serverUrl: 'http://srv:6767', authSecretRef: 'as-auth' } },
    getSecret: (k) => (k === 'as-auth' ? 'AGENTSPAN_AUTH_KEY=k\nAGENTSPAN_AUTH_SECRET=s' : undefined),
  }
  const { client, config } = buildClient(ctx, mockFetch({ json: {} }))
  assert.equal(config.serverUrl, 'http://srv:6767')
  assert.equal(client.auth.key, 'k')
  // missing secret → no auth, no crash
  const noSecret = buildClient({ settings: { agentspan: { authSecretRef: 'nope' } }, getSecret: () => undefined }, mockFetch({ json: {} }))
  assert.equal(noSecret.client.auth, undefined)
})

// ─── plugin glue: normalization helpers ────────────────────────────────────
test('summarizeStatus normalizes agent + workflow payloads', () => {
  const a = summarizeStatus({ executionId: 'e1', agentName: 'bot', status: 'RUNNING', tasks: [{ status: 'COMPLETED' }, { status: 'FAILED' }] })
  assert.equal(a.status, 'RUNNING')
  assert.equal(a.taskCount, 2)
  assert.equal(a.completedTasks, 1)
  assert.equal(a.failedTasks, 1)
  const w = summarizeStatus({ workflowId: 'w1', workflowName: 'cleanup', status: 'COMPLETED', reasonForIncompletion: undefined })
  assert.equal(w.name, 'cleanup')
  assert.equal(w.status, 'COMPLETED')
  assert.deepEqual(summarizeStatus(null), { status: 'UNKNOWN' })
})

test('toExecutionRows handles results/workflows/array shapes', () => {
  assert.equal(toExecutionRows({ results: [{ workflowId: 'a', workflowName: 'x', status: 'RUNNING' }] }).length, 1)
  assert.equal(toExecutionRows({ workflows: [{ id: 'b', name: 'y', status: 'FAILED' }] })[0].status, 'FAILED')
  assert.equal(toExecutionRows([{ workflowId: 'c' }]).length, 1)
  assert.deepEqual(toExecutionRows({}), [])
})

test('isFailedExecution matches terminal-failure statuses only', () => {
  assert.ok(isFailedExecution('FAILED'))
  assert.ok(isFailedExecution('terminated'))
  assert.ok(isFailedExecution('TIMED_OUT'))
  assert.ok(!isFailedExecution('RUNNING'))
  assert.ok(!isFailedExecution('COMPLETED'))
})

// ─── plugin registration + tool behavior (mocked server) ──────────────────
/** Build a ctx with register* capture + a mocked client injected. */
function makeCtx(fetchImpl, settings = {}) {
  const tools = new Map()
  const triggers = []
  const panels = []
  const logs = []
  const ctx = {
    settings: { agentspan: settings },
    registerTool: (t) => tools.set(t.name, t),
    registerTrigger: (t) => triggers.push(t),
    registerPanel: (p) => panels.push(p),
    log: (l) => logs.push(l),
  }
  // inject the mocked fetch by overriding buildClient's realFetch via a hack:
  // we re-register with a patched client below.
  return { tools, triggers, panels, logs, ctx }
}

test('register wires 6 tools, 1 trigger, 1 panel', () => {
  const { tools, triggers, panels, ctx } = makeCtx(null, { serverUrl: 'http://x:6767' })
  register(ctx)
  assert.equal(tools.size, 6)
  for (const n of ['agentspan_health', 'agentspan_run', 'agentspan_status', 'agentspan_approve', 'agentspan_list', 'agentspan_stop']) assert.ok(tools.has(n), `missing ${n}`)
  assert.equal(triggers.length, 1)
  assert.equal(panels.length, 1)
})

test('agentspan_health returns error+hint when server unreachable (no throw)', async () => {
  const { tools, ctx } = makeCtx(null, { serverUrl: 'http://down:6767' })
  // force a failing fetch by monkey-patching global fetch
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED') }
  register(ctx)
  const r = await tools.get('agentspan_health').handler({})
  assert.equal(r.error && true, true)
  assert.match(r.hint, /AgentSpan server running/)
  globalThis.fetch = realFetch
})

test('agentspan_run (agentConfig) returns executionId + uiUrl from a live mock server', async () => {
  const { tools, ctx } = makeCtx(null, { serverUrl: DEFAULT_BASE_URL })
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({ executionId: 'exec-42' }),
  })
  register(ctx)
  const r = await tools.get('agentspan_run').handler({ agentConfig: { name: 'a' }, prompt: 'hi' })
  assert.equal(r.executionId, 'exec-42')
  assert.match(r.uiUrl, /\/execution\/exec-42$/)
  globalThis.fetch = realFetch
})

test('agentspan_run (workflow) returns workflowId; needs agentConfig-or-workflow', async () => {
  const { tools, ctx } = makeCtx(null, { serverUrl: DEFAULT_BASE_URL })
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => 'wf-7' })
  register(ctx)
  const r = await tools.get('agentspan_run').handler({ workflow: 'cleanup', input: { h: 1 } })
  assert.equal(r.workflowId, 'wf-7')
  const bad = await tools.get('agentspan_run').handler({})
  assert.match(bad.error, /agentConfig or workflow/)
  globalThis.fetch = realFetch
})

test('agentspan_status falls back to workflow engine when agent surface 404s', async () => {
  const { tools, ctx } = makeCtx(null, { serverUrl: DEFAULT_BASE_URL })
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (url.includes('/api/agent/')) return { ok: false, status: 404, text: async () => 'not an agent' }
    return { ok: true, status: 200, text: async () => JSON.stringify({ workflowId: 'w1', workflowName: 'cleanup', status: 'COMPLETED', tasks: [] }) }
  }
  register(ctx)
  const r = await tools.get('agentspan_status').handler({ executionId: 'w1' })
  assert.equal(r.kind, 'workflow')
  assert.equal(r.status, 'COMPLETED')
  globalThis.fetch = realFetch
})

test('agentspan_approve responds + reports new status; requires id', async () => {
  const { tools, ctx } = makeCtx(null, { serverUrl: DEFAULT_BASE_URL })
  const realFetch = globalThis.fetch
  const posted = []
  globalThis.fetch = async (url, init) => {
    if (init.method === 'POST' && url.includes('/respond')) { posted.push(url); return { ok: true, status: 200, text: async () => '' } }
    return { ok: true, status: 200, text: async () => JSON.stringify({ executionId: 'e1', status: 'RUNNING' }) }
  }
  register(ctx)
  const bad = await tools.get('agentspan_approve').handler({})
  assert.match(bad.error, /executionId/)
  const r = await tools.get('agentspan_approve').handler({ executionId: 'e1', output: { approved: true } })
  assert.equal(r.responded, true)
  assert.ok(posted[0].includes('/api/agent/e1/respond'))
  globalThis.fetch = realFetch
})

test('agentspan_list returns normalized execution rows', async () => {
  const { tools, ctx } = makeCtx(null, { serverUrl: DEFAULT_BASE_URL })
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ results: [{ workflowId: 'a', workflowName: 'x', status: 'RUNNING' }, { workflowId: 'b', workflowName: 'y', status: 'FAILED' }] }) })
  register(ctx)
  const r = await tools.get('agentspan_list').handler({})
  assert.equal(r.count, 2)
  assert.equal(r.executions[1].status, 'FAILED')
  globalThis.fetch = realFetch
})

test('agentspan_stop tries agent stop then terminates workflow; requires id', async () => {
  const { tools, ctx } = makeCtx(null, { serverUrl: DEFAULT_BASE_URL })
  const realFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push(`${init.method} ${url}`)
    if (url.includes('/api/agent/') && url.includes('/stop')) return { ok: false, status: 404, text: async () => 'no' }
    return { ok: true, status: 200, text: async () => '' }
  }
  register(ctx)
  const bad = await tools.get('agentspan_stop').handler({})
  assert.match(bad.error, /executionId/)
  const r = await tools.get('agentspan_stop').handler({ executionId: 'w1' })
  assert.equal(r.stopped, true)
  assert.ok(calls.some((c) => c.startsWith(`DELETE ${DEFAULT_BASE_URL}/api/workflow/w1`)))
  globalThis.fetch = realFetch
})

test('trigger fires only for agentspan FAILED events', () => {
  const { triggers, ctx } = makeCtx(null, {})
  register(ctx)
  const t = triggers[0]
  assert.ok(t.match({ source: 'agentspan', status: 'FAILED' }))
  assert.ok(!t.match({ source: 'agentspan', status: 'RUNNING' }))
  assert.ok(!t.match({ source: 'netdata', status: 'FAILED' }))
})

test('panel renders an executions table', () => {
  const { panels, ctx } = makeCtx(null, { serverUrl: 'http://x:6767' })
  register(ctx)
  const html = panels[0].render([{ name: 'cleanup', id: 'e1', status: 'RUNNING', startTime: 'now' }])
  assert.match(html, /cleanup/)
  assert.match(html, /http:\/\/x:6767/)
})
