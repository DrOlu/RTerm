import { register, resolveConfig, envelope, discoverAgents, dispatchTask, registerSelf, __setConnForTest } from './index.mjs'

const cases = []
function test(n, r) { cases.push({ name: n, run: r }) }
function assert(c, m) { if (!c) throw new Error(m ?? 'assertion failed') }
function eq(a, b, m) { if (a !== b) throw new Error(`${m ?? 'eq'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }

// ─── fake NATS connection ───────────────────────────────────────────────────
function fakeConn() {
  const published = []
  const requests = new Map()
  return {
    isClosed: () => false,
    publish(subject, data) { published.push({ subject, data: JSON.parse(new TextDecoder().decode(data)) }) },
    async request(subject, data, _opts) {
      const h = requests.get(subject)
      const reply = h ? h(JSON.parse(new TextDecoder().decode(data))) : { ok: true }
      return { data: new TextEncoder().encode(JSON.stringify(reply)) }
    },
    _on(subject, h) { requests.set(subject, h) },
    published,
    drain: async () => {},
  }
}

function mkCtx(settings = {}, conn) {
  const tools = new Map(); const triggers = []; const panels = []; const logs = []
  const ctx = {
    settings: { synapse: settings },
    natsConnect: async () => conn,
    registerTool: (t) => tools.set(t.name, t),
    registerTrigger: (t) => triggers.push(t),
    registerPanel: (p) => panels.push(p),
    log: (l) => logs.push(l),
  }
  return { tools, triggers, panels, logs, ctx }
}

// ─── config ─────────────────────────────────────────────────────────────────

test('resolveConfig defaults (url, prefix=mesh, agentId=rterm-001)', () => {
  const c = resolveConfig({ settings: {} }, {})
  eq(c.servers, 'nats://localhost:4222', 'default url')
  eq(c.prefix, 'mesh', 'default prefix')
  eq(c.agentId, 'rterm-001', 'default agentId')
  eq(c.enabled, true, 'enabled default')
})

test('resolveConfig reads settings.synapse block', () => {
  const c = resolveConfig({ settings: { synapse: { url: 'nats://h:4222', prefix: 'mesh', agentId: 'rterm-x', auth: { token: 't' } } } }, {})
  eq(c.servers, 'nats://h:4222', 'url from settings')
  eq(c.agentId, 'rterm-x', 'agentId from settings')
  eq(c.auth.token, 't', 'auth token')
})

// ─── envelope ───────────────────────────────────────────────────────────────

test('envelope has Synapse v0.3.0 shape', () => {
  const cfg = { agentId: 'rterm-001' }
  const e = envelope('discover', { capabilities: [] }, cfg)
  eq(e.v, '0.3.0', 'protocol version')
  eq(e.type, 'discover', 'type')
  eq(e.from, 'rterm-001', 'from = agentId')
  assert(e.id, 'has id')
  assert(e.ts, 'has ts')
  assert(e.trace?.trace_id && e.trace?.span_id, 'has trace context')
  assert(e.payload, 'has payload')
})

// ─── register wiring ────────────────────────────────────────────────────────

test('register wires 5 tools, 1 trigger, 1 panel', () => {
  const conn = fakeConn()
  const { tools, triggers, panels, ctx } = mkCtx({}, conn)
  register(ctx)
  eq(tools.size, 5, 'tool count')
  for (const n of ['synapse_health', 'synapse_discover', 'synapse_dispatch', 'synapse_register', 'synapse_agents_summary']) assert(tools.has(n), `missing ${n}`)
  eq(triggers.length, 1, 'trigger count')
  eq(triggers[0].name, 'synapse_mesh_event', 'trigger name')
  eq(panels.length, 1, 'panel count')
})

// ─── discover ───────────────────────────────────────────────────────────────

test('synapse_discover returns agents from registry', async () => {
  const conn = fakeConn()
  conn._on('mesh.registry.discover', () => [
    { id: 'grip-cli-001', name: 'Grip CLI', skills: [{ id: 'himalaya' }] },
    { id: 'agentspan-001', name: 'Agentspan', skills: [{ id: 'status' }] },
  ])
  const { tools, ctx } = mkCtx({}, conn)
  register(ctx)
  const r = await tools.get('synapse_discover').handler({})
  eq(r.count, 2, 'agent count')
  eq(r.agents[0].id, 'grip-cli-001', 'first agent')
})

test('synapse_discover passes filter through to the envelope', async () => {
  __setConnForTest(null)
  const conn = fakeConn()
  let captured
  conn._on('mesh.registry.discover', (env) => { captured = env; return [] })
  const { tools, ctx } = mkCtx({}, conn)
  register(ctx)
  await tools.get('synapse_discover').handler({ capabilities: ['chat'], availability: 'online' })
  eq(captured.type, 'discover', 'envelope type')
  eq(captured.payload.availability, 'online', 'filter availability')
  assert(Array.isArray(captured.payload.capabilities), 'filter capabilities')
})

// ─── dispatch ───────────────────────────────────────────────────────────────

test('synapse_dispatch sends request to agent inbox + returns response', async () => {
  __setConnForTest(null)
  const conn = fakeConn()
  let captured
  conn._on('mesh.agent.grip-001.inbox', (env) => { captured = env; return { stream: 'AGENT_INBOXES', seq: 42 } })
  const { tools, ctx } = mkCtx({}, conn)
  register(ctx)
  const r = await tools.get('synapse_dispatch').handler({ target: 'grip-001', skill: 'respond', input: { text: 'hi' } })
  eq(r.response.seq, 42, 'response seq')
  eq(captured.type, 'request', 'envelope type')
  eq(captured.to, 'grip-001', 'envelope to')
  eq(captured.payload.skill, 'respond', 'skill')
  eq(captured.payload.input.text, 'hi', 'input')
})

test('synapse_dispatch requires target + skill', async () => {
  const conn = fakeConn()
  const { tools, ctx } = mkCtx({}, conn)
  register(ctx)
  const r = await tools.get('synapse_dispatch').handler({})
  assert(r.error, 'expected error for missing target/skill')
})

// ─── register self ──────────────────────────────────────────────────────────

test('synapse_register publishes a register envelope to the registry', async () => {
  __setConnForTest(null)
  const conn = fakeConn()
  const { tools, ctx } = mkCtx({ agentId: 'rterm-001' }, conn)
  register(ctx)
  const r = await tools.get('synapse_register').handler({ name: 'RTerm', capabilities: ['ops'] })
  eq(r.registered, 'rterm-001', 'registered id')
  const pub = conn.published.find((p) => p.subject === 'mesh.registry.register')
  assert(pub, 'expected a register publish')
  eq(pub.data.type, 'register', 'envelope type')
  eq(pub.data.payload.agent_id, 'rterm-001', 'payload agent_id')
  assert(pub.data.payload.endpoint.includes('rterm-001.inbox'), 'endpoint inbox')
})

// ─── trigger match ──────────────────────────────────────────────────────────

test('synapse_mesh_event trigger matches only synapse-source events', () => {
  const conn = fakeConn()
  const { triggers, ctx } = mkCtx({}, conn)
  register(ctx)
  const t = triggers[0]
  assert(t.match({ source: 'synapse' }), 'matches synapse source')
  assert(!t.match({ source: 'other' }), 'rejects other source')
  assert(!t.match({}), 'rejects empty')
})

// ─── runner ─────────────────────────────────────────────────────────────────
async function main() {
  let pass = 0, fail = 0
  for (const c of cases) {
    try { await c.run(); pass++; console.log(`PASS ${c.name}`) }
    catch (e) { fail++; console.log(`FAIL ${c.name}: ${e?.message ?? e}`) }
  }
  console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}
main()
