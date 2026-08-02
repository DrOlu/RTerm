import { register, resolveConfig, envelope, discoverAgents, dispatchTask, registerSelf, __setConnForTest } from './index.mjs'

const cases = []
function test(n, r) { cases.push({ name: n, run: r }) }
function assert(c, m) { if (!c) throw new Error(m ?? 'assertion failed') }
function eq(a, b, m) { if (a !== b) throw new Error(`${m ?? 'eq'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }

// ─── fake NATS connection (with wildcard + JetStream ack simulation) ─────────
function subjectMatches(pattern, subject) {
  if (pattern === subject) return true
  const p = pattern.split('.')
  const s = subject.split('.')
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '>') return true
    if (i >= s.length) return false
    if (p[i] !== '*' && p[i] !== s[i]) return false
  }
  return p.length === s.length
}

function fakeConn() {
  const published = []
  const subs = new Map()
  const requests = new Map()
  const deliver = (subject, data, respondFn) => {
    for (const [pattern, fns] of subs) {
      if (subjectMatches(pattern, subject)) {
        for (const fn of fns) fn({ data, subject, respond: respondFn })
      }
    }
  }
  return {
    isClosed: () => false,
    publish(subject, data, opts) {
      const env = JSON.parse(new TextDecoder().decode(data))
      published.push({ subject, env, opts })
      // Simulate JetStream ack on the reply subject (if reply-to is set)
      if (opts?.reply) {
        const ack = new TextEncoder().encode(JSON.stringify({ stream: 'AGENT_INBOXES', seq: published.length }))
        deliver(opts.reply, ack, () => {})
      }
      // Deliver to any matching subscribers
      deliver(subject, data, (p) => { published.push({ subject: '_reply', env: JSON.parse(new TextDecoder().decode(p)) }) })
    },
    subscribe(subject) {
      return {
        async *[Symbol.asyncIterator]() {
          while (true) {
            const m = await new Promise((res) => {
              const l = subs.get(subject) ?? []; subs.set(subject, l); l.push(res)
            })
            yield m
          }
        },
        unsubscribe: () => subs.delete(subject),
      }
    },
    async request(subject, data, _opts) {
      const env = JSON.parse(new TextDecoder().decode(data))
      const h = requests.get(subject)
      const reply = h ? h(env) : { ok: true }
      return { data: new TextEncoder().encode(JSON.stringify(reply)) }
    },
    _deliver(subject, env) {
      const data = new TextEncoder().encode(JSON.stringify(env))
      deliver(subject, data, (p) => { published.push({ subject: '_reply', env: JSON.parse(new TextDecoder().decode(p)) }) })
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

test('resolveConfig includes dispatchTimeout (default 600000) + meshes', () => {
  const c = resolveConfig({ settings: {} }, {})
  eq(c.dispatchTimeout, 600000, 'default dispatchTimeout 600s')
  eq(c.meshes, undefined, 'no meshes by default')
})

test('resolveConfig reads dispatchTimeout + meshes from settings', () => {
  const c = resolveConfig({ settings: { synapse: { dispatchTimeout: 30000, meshes: [{ name: 'prod', url: 'nats://p:4222' }] } } }, {})
  eq(c.dispatchTimeout, 30000, 'dispatchTimeout from settings')
  assert(Array.isArray(c.meshes) && c.meshes.length === 1, 'meshes array')
})

// ─── dispatch: skip JetStream ack, wait for real respond ─────────────────────

test('dispatchTask skips JetStream ack and returns the real respond envelope', async () => {
  __setConnForTest(null)
  const conn = fakeConn()
  const ctx = {
    settings: { synapse: { url: 'nats://fake:4222', agentId: 'rterm-001', prefix: 'mesh', dispatchTimeout: 5000 } },
    natsConnect: async () => conn,
    registerTool: () => {}, registerTrigger: () => {}, registerPanel: () => {}, log: () => {},
  }
  // Simulate the agent responding after the JetStream ack
  // The reply subject is _INBOX.synapse.* — we need to deliver the respond there
  // The JetStream ack is auto-delivered by fakeConn.publish (opts.reply)
  // We need to manually deliver the real respond to the reply subject
  setTimeout(() => {
    // Find the reply subject from published messages
    const pub = conn.published.find(p => p.opts?.reply && p.subject === 'mesh.agent.grip-001.inbox')
    if (pub) {
      const respond = { v: '0.3.0', id: 'r1', type: 'respond', from: 'grip-001', to: 'rterm-001', payload: { output: { ok: true, incidents: [] } } }
      conn._deliver(pub.opts.reply, respond)
    }
  }, 50)

  const result = await dispatchTask(ctx, 'grip-001', 'status', {})
  eq(result.type, 'respond', 'should be a respond envelope')
  eq(result.from, 'grip-001', 'from the target agent')
  assert(result.payload?.output?.ok === true, 'output present')
})

test('dispatchTask returns clear error on timeout (no respond)', async () => {
  __setConnForTest(null)
  const conn = fakeConn()
  const ctx = {
    settings: { synapse: { url: 'nats://fake:4222', agentId: 'rterm-001', prefix: 'mesh', dispatchTimeout: 500 } },
    natsConnect: async () => conn,
    registerTool: () => {}, registerTrigger: () => {}, registerPanel: () => {}, log: () => {},
  }
  // No agent responds — should timeout
  const result = await dispatchTask(ctx, 'no-such-agent', 'status', {})
  assert(result.error, 'should have error on timeout')
  assert(result.error.includes('did not respond'), 'error message mentions timeout')
  assert(result.error.includes('synapse_serve_status'), 'error hints at serve_status')
})

test('dispatchTask: JetStream ack is skipped, not returned as result', async () => {
  __setConnForTest(null)
  const conn = fakeConn()
  const ctx = {
    settings: { synapse: { url: 'nats://fake:4222', agentId: 'rterm-001', prefix: 'mesh', dispatchTimeout: 2000 } },
    natsConnect: async () => conn,
    registerTool: () => {}, registerTrigger: () => {}, registerPanel: () => {}, log: () => {},
  }
  // The fakeConn auto-delivers a JetStream ack on the reply subject.
  // Then we deliver the real respond after 50ms.
  setTimeout(() => {
    const pub = conn.published.find(p => p.opts?.reply && p.subject === 'mesh.agent.test-001.inbox')
    if (pub) {
      conn._deliver(pub.opts.reply, { type: 'respond', from: 'test-001', payload: { output: { data: 42 } } })
    }
  }, 50)

  const result = await dispatchTask(ctx, 'test-001', 'compute', { n: 42 })
  // Must NOT be the JetStream ack
  assert(!result.stream, 'must not be a JetStream ack')
  eq(result.type, 'respond', 'must be a respond envelope')
  eq(result.payload.output.data, 42, 'output data correct')
})

// ─── multi-mesh discover ─────────────────────────────────────────────────────

test('discoverAgents merges results from multiple meshes + tags _mesh', async () => {
  __setConnForTest(null)
  const connA = fakeConn()
  const connB = fakeConn()
  connA._on('mesh.registry.discover', () => [{ id: 'agent-a1', name: 'A1' }])
  connB._on('mesh.registry.discover', () => [{ id: 'agent-b1', name: 'B1' }])
  let which = 0
  const ctx = {
    settings: { synapse: { meshes: [
      { name: 'mesh-a', url: 'nats://a:4222' },
      { name: 'mesh-b', url: 'nats://b:4222' },
    ]}},
    natsConnect: async () => { which++; return which === 1 ? connA : connB },
    registerTool: () => {}, registerTrigger: () => {}, registerPanel: () => {}, log: () => {},
  }
  const agents = await discoverAgents(ctx, {})
  eq(agents.length, 2, 'merged from both meshes')
  const a1 = agents.find(a => a.id === 'agent-a1')
  const b1 = agents.find(a => a.id === 'agent-b1')
  assert(a1 && a1._mesh === 'mesh-a', 'agent-a1 tagged with mesh-a')
  assert(b1 && b1._mesh === 'mesh-b', 'agent-b1 tagged with mesh-b')
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
