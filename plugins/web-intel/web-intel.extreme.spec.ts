/**
 * web-intel.extreme.spec.ts — exhaustive offline tests for the web-intel plugin:
 * the dependency-free wigolo REST client (URL building, auth header, error
 * mapping, every endpoint), the sidecar lifecycle (lean-by-default spawn plan,
 * start/stop/status), and the plugin glue (config resolution, tool wiring,
 * unreachable-daemon resilience, result normalization, trigger match). No
 * network — fetch is mocked; spawn is injected/mocked.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WigoloClient, WigoloApiError, buildHeaders, joinUrl, DEFAULT_BASE_URL } from './wigoloClient.mjs'
import { WigoloSidecar, buildServePlan, buildInitPlan } from './sidecar.mjs'
import {
  register,
  resolveConfig,
  buildClient,
  toResultRows,
  toPageSummary,
  toResearchBrief,
  toWatchRows,
  isPageChangedEvent,
} from './index.mjs'

// ─── mock fetch ─────────────────────────────────────────────────────────────
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

// ─── wigoloClient ───────────────────────────────────────────────────────────

test('joinUrl joins base + path with a single slash', () => {
  assert.equal(joinUrl('http://x:3333/', '/health'), 'http://x:3333/health')
  assert.equal(joinUrl('http://x:3333', 'health'), 'http://x:3333/health')
  assert.equal(joinUrl('', '/v1/search'), `${DEFAULT_BASE_URL}/v1/search`)
})

test('buildHeaders adds bearer token only when set', () => {
  assert.equal(buildHeaders().authorization, undefined)
  assert.equal(buildHeaders('tok').authorization, 'Bearer tok')
})

test('client.health() GETs /health without auth and maps ok/error', async () => {
  const up = mockFetch({ json: { status: 'ok', searxng: 'not_configured' } })
  const c = new WigoloClient({ fetchImpl: up })
  const h = await c.health()
  assert.equal(h.ok, true)
  assert.equal(up.calls[0].url, `${DEFAULT_BASE_URL}/health`)

  const down = mockFetch(() => { throw new Error('ECONNREFUSED') })
  const h2 = await new WigoloClient({ fetchImpl: down }).health()
  assert.equal(h2.ok, false)
  assert.match(h2.error, /ECONNREFUSED/)
})

test('client.search() POSTs query (+ array) to /v1/search with token header', async () => {
  const f = mockFetch({ json: { results: [] } })
  const c = new WigoloClient({ token: 'tok', fetchImpl: f })
  await c.search(['a', 'b'], { time_range: 'week', max_results: 5 })
  assert.equal(f.calls[0].url, `${DEFAULT_BASE_URL}/v1/search`)
  assert.equal(f.calls[0].init.method, 'POST')
  assert.equal(f.calls[0].init.headers.authorization, 'Bearer tok')
  const body = JSON.parse(f.calls[0].init.body)
  assert.deepEqual(body.query, ['a', 'b'])
  assert.equal(body.time_range, 'week')
  assert.equal(body.max_results, 5)
})

test('client maps non-2xx to WigoloApiError with status', async () => {
  const f = mockFetch({ status: 500, text: 'boom' })
  const c = new WigoloClient({ fetchImpl: f })
  await assert.rejects(() => c.fetch('https://x'), (e) => {
    assert.ok(e instanceof WigoloApiError)
    assert.equal(e.status, 500)
    return true
  })
})

test('client.watch() sends action + url for create/list/remove', async () => {
  const f = mockFetch({ json: { id: 'w1' } })
  const c = new WigoloClient({ fetchImpl: f })
  await c.watch('create', { url: 'https://x', interval: '1h' })
  assert.equal(JSON.parse(f.calls[0].init.body).action, 'create')
  await c.watch('list')
  assert.equal(JSON.parse(f.calls[1].init.body).action, 'list')
  await c.watch('remove', { id: 'w1' })
  assert.equal(JSON.parse(f.calls[2].init.body).action, 'remove')
})

// ─── sidecar ────────────────────────────────────────────────────────────────

test('buildServePlan is lean by default (WIGOLO_NO_WARMUP=1, no token)', () => {
  const p = buildServePlan({})
  assert.equal(p.command, 'npx')
  assert.deepEqual(p.args.slice(0, 3), ['-y', 'wigolo', 'serve'])
  assert.equal(p.env.WIGOLO_NO_WARMUP, '1')
  assert.equal(p.env.WIGOLO_API_TOKEN, undefined)
})

test('buildServePlan honors port/host/token and warmup=true omits the no-warmup flag', () => {
  const p = buildServePlan({ port: 3477, host: '0.0.0.0', token: 't', warmup: true })
  assert.ok(p.args.includes('3477'))
  assert.equal(p.env.WIGOLO_NO_WARMUP, undefined)
  assert.equal(p.env.WIGOLO_API_TOKEN, 't')
})

test('sidecar.start() spawns detached + unref and is idempotent', async () => {
  const spawned = []
  const spawnImpl = (cmd, args, opts) => { spawned.push({ cmd, args, opts }); return { unref() {}, kill() {} } }
  const sc = new WigoloSidecar({ spawnImpl, log: () => {} })
  await sc.start()
  await sc.start() // idempotent — no second spawn
  assert.equal(spawned.length, 1)
  assert.equal(spawned[0].opts.detached, true)
  assert.equal(sc.isRunning(), true)
  assert.equal(sc.status().warmup, 'lean (no warmup)')
})

test('sidecar.stop() kills the process', async () => {
  let killed = false
  const spawnImpl = () => ({ unref() {}, kill() { killed = true } })
  const sc = new WigoloSidecar({ spawnImpl, log: () => {} })
  await sc.start()
  await sc.stop()
  assert.equal(killed, true)
  assert.equal(sc.isRunning(), false)
})

// ─── plugin glue ────────────────────────────────────────────────────────────

function makeCtx(fetchImpl, settings = {}, spawnProcess) {
  const tools = new Map()
  const triggers = []
  const panels = []
  const logs = []
  const ctx = {
    settings: { webIntel: settings },
    fetchImpl,
    registerTool: (t) => tools.set(t.name, t),
    registerTrigger: (t) => triggers.push(t),
    registerPanel: (p) => panels.push(p),
    log: (l) => logs.push(l),
    ...(spawnProcess ? { spawnProcess } : {}),
  }
  return { tools, triggers, panels, logs, ctx }
}

test('resolveConfig reads the webIntel block with lean defaults', () => {
  const c = resolveConfig({ settings: { webIntel: { restUrl: ' http://x:3477/ ', warmupOnInit: true, autoStart: false } } })
  assert.equal(c.restUrl, 'http://x:3477', 'restUrl trimmed of whitespace + trailing slash')
  assert.equal(c.warmupOnInit, true)
  assert.equal(c.autoStart, false)
  const d = resolveConfig({ settings: {} })
  assert.equal(d.enabled, true)
  assert.equal(d.autoStart, true)
  assert.equal(d.warmupOnInit, false)
})

test('register wires 9 tools, 1 trigger, 1 panel', () => {
  const { tools, triggers, panels, ctx } = makeCtx(mockFetch({ json: {} }))
  register(ctx)
  assert.equal(tools.size, 9)
  for (const n of ['webintel_health', 'web_search', 'web_fetch', 'web_crawl', 'web_research', 'web_find_similar', 'web_watch_add', 'web_watch_list', 'web_watch_remove']) assert.ok(tools.has(n), `missing ${n}`)
  assert.equal(triggers.length, 1)
  assert.equal(panels.length, 1)
})

test('web_search returns normalized ranked results', async () => {
  const f = mockFetch((url) => url.endsWith('/health')
    ? { json: { status: 'ok' } }
    : { json: { results: [{ title: 'A', url: 'https://a', excerpt: 'x'.repeat(300), citation_id: 'src-1', evidence_score: { final: 0.9 } }], freshness_signal: { published: '2026-07-01' } } })
  const { tools, ctx } = makeCtx(f)
  register(ctx)
  const r = await tools.get('web_search').handler({ query: 'cisco bgp error' })
  assert.equal(r.results.length, 1)
  assert.equal(r.results[0].citation, 'src-1')
  assert.equal(r.results[0].score, 0.9)
  assert.ok(r.results[0].excerpt.length <= 240)
  assert.equal(r.freshness.published, '2026-07-01')
})

test('web_research returns the evidence brief (synthesis left to RTerm agent)', async () => {
  const f = mockFetch((url) => url.endsWith('/health')
    ? { json: { status: 'ok' } }
    : { json: { question: 'q', evidence: [{ title: 'S', url: 'https://s', snippet: 'ev' }], citations: [{ id: 'src-1', url: 'https://s' }] } })
  const { tools, ctx } = makeCtx(f)
  register(ctx)
  const r = await tools.get('web_research').handler({ question: 'is rijndael128-cbc safe' })
  assert.equal(r.evidence.length, 1)
  assert.equal(r.citations.length, 1)
  assert.match(r.note, /RTerm agent/)
})

test('web_fetch surfaces a blocked page honestly', async () => {
  const f = mockFetch((url) => url.endsWith('/health')
    ? { json: { status: 'ok' } }
    : { json: { url: 'https://x', blocked_by_challenge: true, markdown: '' } })
  const { tools, ctx } = makeCtx(f)
  register(ctx)
  const r = await tools.get('web_fetch').handler({ url: 'https://x' })
  assert.equal(r.blocked, true)
})

test('every web_* tool returns error+hint when daemon is down and no spawn (no throw)', async () => {
  const down = mockFetch(() => { throw new Error('ECONNREFUSED') })
  const { tools, ctx } = makeCtx(down, { autoStart: true }) // no spawnProcess → can't start
  register(ctx)
  const r = await tools.get('web_search').handler({ query: 'x' })
  assert.ok(r.error)
  assert.match(r.hint, /wigolo daemon/)
})

test('web_search auto-starts the daemon via spawnProcess then serves', async () => {
  let healthy = false
  const spawned = []
  const f = mockFetch((url) => url.endsWith('/health')
    ? (healthy ? { json: { status: 'ok' } } : (() => { throw new Error('down') })())
    : { json: { results: [] } })
  const spawnProcess = (cmd, args, opts) => { spawned.push(true); healthy = true; return { unref() {}, kill() {} } }
  const { tools, ctx } = makeCtx(f, { autoStart: true }, spawnProcess)
  register(ctx)
  const r = await tools.get('web_search').handler({ query: 'x' })
  assert.equal(spawned.length, 1)
  assert.ok(Array.isArray(r.results))
})

test('webintel_page_changed trigger matches only webintel change events', () => {
  const { triggers, ctx } = makeCtx(mockFetch({ json: {} }))
  register(ctx)
  const m = triggers[0].match
  assert.equal(m({ source: 'webintel', changed: true }), true)
  assert.equal(m({ source: 'webintel', kind: 'page_changed' }), true)
  assert.equal(m({ source: 'agentspan', changed: true }), false)
  assert.equal(m({ source: 'webintel', changed: false }), false)
})

// ─── normalization helpers ─────────────────────────────────────────────────

test('toResultRows normalizes + truncates excerpts', () => {
  const rows = toResultRows({ results: [{ url: 'https://a', description: 'y'.repeat(400) }] })
  assert.equal(rows.length, 1)
  assert.ok(rows[0].excerpt.length <= 240)
  assert.equal(toResultRows({}).length, 0)
})

test('toResearchBrief handles empty payload', () => {
  assert.deepEqual(toResearchBrief(null).evidence, [])
  assert.equal(toResearchBrief({ evidence: [] }).evidence.length, 0)
})

test('toWatchRows normalizes watch entries', () => {
  const rows = toWatchRows({ watches: [{ id: 'w1', url: 'https://x', changed: true, last_checked: '2026-07-28' }] })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].changed, true)
})

console.log('web-intel: all cases passed')
