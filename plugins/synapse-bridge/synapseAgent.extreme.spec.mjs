import {
  buildRespond, executeSkill, startResponder,
  emitEvent, subscribeEvents,
  ReputationStore, computeScore, updateRecord, newRecord, REP_WEIGHTS,
  requestApproval, respondApproval, startApprover,
} from './synapseAgent.mjs'

const cases = []
function test(n, r) { cases.push({ name: n, run: r }) }
function assert(c, m) { if (!c) throw new Error(m ?? 'assertion failed') }
function eq(a, b, m) { if (a !== b) throw new Error(`${m ?? 'eq'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }

const enc = new TextEncoder()
const dec = new TextDecoder()
const CFG = { agentId: 'rterm-001', prefix: 'mesh' }

// ─── fake NATS connection (pub/sub + request/reply) ─────────────────────────
// NATS wildcard grammar: '*' matches one token, '>' matches one or more (suffix).
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
    published,
    publish(subject, data) {
      const env = JSON.parse(dec.decode(data))
      published.push({ subject, env })
      deliver(subject, data, (p) => { published.push({ subject: '_reply', env: JSON.parse(dec.decode(p)) }) })
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
    async request(subject, data, _o) {
      const env = JSON.parse(dec.decode(data))
      const h = requests.get(subject)
      const reply = h ? h(env) : { payload: { approved: true, approver: 'did:mesh:approver' } }
      return { data: enc.encode(JSON.stringify(reply)) }
    },
    _deliver(subject, env) {
      const data = enc.encode(JSON.stringify(env))
      deliver(subject, data, (p) => { published.push({ subject: '_reply', env: JSON.parse(dec.decode(p)) }) })
    },
    _onRequest(subject, h) { requests.set(subject, h) },
  }
}

// ─── 1. RESPONDER ────────────────────────────────────────────────────────────

test('buildRespond: output envelope has to/task_id/in_reply_to + output payload', () => {
  const req = { id: 'req-1', from: 'caller-001', task_id: 'task-9', payload: { skill: 'x' } }
  const r = buildRespond(req, CFG, { output: { result: 42 } })
  eq(r.type, 'respond', 'type')
  eq(r.to, 'caller-001', 'to = original from')
  eq(r.task_id, 'task-9', 'task_id')
  eq(r.in_reply_to, 'req-1', 'in_reply_to = original id')
  eq(r.payload.output.result, 42, 'output payload')
  assert(!r.payload.error, 'no error when output present')
})

test('buildRespond: error envelope has error payload, no output; output+error throws', () => {
  const req = { id: 'r2', from: 'c', task_id: 't' }
  const r = buildRespond(req, CFG, { error: { code: 3001, message: 'nf' } })
  eq(r.payload.error.code, 3001, 'error code')
  assert(!r.payload.output, 'no output when error present')
  let threw = false
  try { buildRespond(req, CFG, { output: {}, error: { code: 1 } }) } catch { threw = true }
  assert(threw, 'output+error must throw')
})

test('executeSkill: known skill returns output; unknown returns 3001 SKILL_NOT_FOUND', async () => {
  const ctx = { rtermSkills: { greet: async (inp) => ({ hello: inp.name }) } }
  const ok = await executeSkill('greet', { name: 'mesh' }, ctx)
  eq(ok.output.hello, 'mesh', 'skill output')
  const nf = await executeSkill('nope', {}, ctx)
  eq(nf.error.code, 3001, 'SKILL_NOT_FOUND code')
})

test('startResponder: inbound request executes skill + responds on reply inbox', async () => {
  const nc = fakeConn()
  const ctx = { rtermSkills: { status: async () => ({ up: true }) } }
  const stop = await startResponder(nc, CFG, ctx)
  nc._deliver('mesh.agent.rterm-001.inbox', { id: 'q1', from: 'caller-001', task_id: 't1', payload: { skill: 'status', input: {} } })
  await new Promise((r) => setTimeout(r, 20))
  const reply = nc.published.find((p) => p.subject === '_reply')
  assert(reply, 'expected a respond on the reply inbox')
  eq(reply.env.type, 'respond', 'respond type')
  eq(reply.env.to, 'caller-001', 'respond to caller')
  eq(reply.env.payload.output.up, true, 'skill output delivered')
  stop()
})

// ─── 2. EMIT / SUBSCRIBE ─────────────────────────────────────────────────────

test('emitEvent publishes a formal emit envelope on mesh.event.{type}', () => {
  const nc = fakeConn()
  emitEvent(nc, CFG, 'ops.change.committed', { changeId: 'chg-1' })
  const pub = nc.published.find((p) => p.subject === 'mesh.event.ops.change.committed')
  assert(pub, 'expected emit publish')
  eq(pub.env.type, 'emit', 'emit type')
  eq(pub.env.payload.changeId, 'chg-1', 'emit payload')
})

test('subscribeEvents invokes handler for each event on the subject', async () => {
  const nc = fakeConn()
  const seen = []
  const stop = await subscribeEvents(nc, 'mesh.event.>', (env, subj) => seen.push({ env, subj }))
  nc._deliver('mesh.event.>', { type: 'emit', payload: { n: 1 } })
  await new Promise((r) => setTimeout(r, 20))
  eq(seen.length, 1, 'one event seen')
  stop()
})

// ─── 3. REPUTATION ───────────────────────────────────────────────────────────

test('computeScore: perfect record scores high', () => {
  const rec = newRecord('a1', 'respond')
  for (let i = 0; i < 5; i++) updateRecord(rec, { status: 'completed', latencyMs: 100 })
  const s = computeScore(rec)
  eq(s.success_rate, 1, 'success_rate 1')
  assert(s.score > 0.8, `high score expected, got ${s.score}`)
  eq(s.confidence, 1.0, 'full confidence at >=min samples')
})

test('updateRecord: failures lower success_rate + score', () => {
  const rec = newRecord('a2', 'respond')
  updateRecord(rec, { status: 'completed', latencyMs: 100 })
  updateRecord(rec, { status: 'failed' })
  updateRecord(rec, { status: 'timeout' })
  const s = computeScore(rec)
  assert(s.success_rate < 0.5, `success_rate should be low, got ${s.success_rate}`)
  assert(s.score < 0.7, `score should be lower, got ${s.score}`)
})

test('reputation: 3 consecutive SKILL_NOT_FOUND flags lying-agent + zeroes score', () => {
  const rec = newRecord('liar', 'respond')
  updateRecord(rec, { status: 'skill_not_found' })
  updateRecord(rec, { status: 'skill_not_found' })
  updateRecord(rec, { status: 'skill_not_found' })
  assert(rec.flags.misleading_capabilities, 'lying-agent flag set')
  eq(rec.flags.penalty_reason.includes('SKILL_NOT_FOUND'), true, 'penalty reason')
  const s = computeScore(rec)
  eq(s.score, 0, 'lying penalty zeroes the score')
})

test('ReputationStore: observe + ranked + handleTaskUpdate', () => {
  const store = new ReputationStore()
  store.observe('a1', 'respond', { status: 'completed', latencyMs: 50 })
  store.observe('a1', 'respond', { status: 'completed', latencyMs: 60 })
  store.observe('a2', 'respond', { status: 'failed' })
  const rec = store.get('a1', 'respond')
  eq(rec.successes, 2, 'two successes recorded')
  // task_update event path
  store.handleTaskUpdate({ payload: { agent: 'a1', skill: 'respond', status: 'completed', latencyMs: 40 } })
  eq(store.get('a1', 'respond').successes, 3, 'task_update fed the store')
  const ranked = store.ranked(0)
  assert(ranked.length >= 2, 'ranked returns all')
  eq(ranked[0].agent_id, 'a1', 'a1 (higher score) ranks first')
})

// ─── 4. GOVERNANCE ───────────────────────────────────────────────────────────

test('requestApproval publishes approval_request + returns approved response', async () => {
  const nc = fakeConn()
  let captured
  nc._onRequest('mesh.approval.task-1.request', (env) => { captured = env; return { payload: { approved: true, approver: 'did:mesh:approver-001' } } })
  const r = await requestApproval(nc, CFG, { taskId: 'task-1', originalRequest: { skill: 'pay' }, reason: 'payment needs approval' })
  eq(captured.type, 'approval_request', 'request type')
  eq(captured.task_id, 'task-1', 'request task_id')
  eq(captured.payload.reason, 'payment needs approval', 'reason')
  eq(r.approved, true, 'approved')
  eq(r.approver, 'did:mesh:approver-001', 'approver')
})

test('respondApproval publishes approval_response on mesh.approval.{taskId}.response', () => {
  const nc = fakeConn()
  const req = { id: 'ar-1', from: 'agent-bob-001', task_id: 'task-7' }
  respondApproval(nc, CFG, req, { approved: false, approver: 'did:mesh:rterm-001' })
  const pub = nc.published.find((p) => p.subject === 'mesh.approval.task-7.response')
  assert(pub, 'expected approval_response publish')
  eq(pub.env.type, 'approval_response', 'response type')
  eq(pub.env.to, 'agent-bob-001', 'to original requester')
  eq(pub.env.payload.approved, false, 'denied')
})

test('startApprover answers inbound approval requests per the decide fn', async () => {
  const nc = fakeConn()
  const stop = await startApprover(nc, CFG, async () => ({ approved: true, approver: 'did:mesh:rterm-001' }))
  nc._deliver('mesh.approval.task-9.request', { id: 'ar-9', from: 'agent-x', task_id: 'task-9', type: 'approval_request', payload: {} })
  await new Promise((r) => setTimeout(r, 20))
  const pub = nc.published.find((p) => p.subject === 'mesh.approval.task-9.response')
  assert(pub, 'expected approver to answer')
  eq(pub.env.payload.approved, true, 'approved by decide fn')
  stop()
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
