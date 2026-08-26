import {
  searchChatHistory,
  extractMessageText,
  buildSnippet,
  findMatches,
} from './history/historySearch'
import {
  isFailoverEligible,
  buildFailoverChain,
  withModelFailover,
} from './AgentHelper/utils/modelFailover'
import { GatewayRateLimiter } from './Gateway/gatewayRateLimit'
import {
  matchRestRoute,
  defaultRestRoutes,
  handleRestRequest,
} from './Gateway/restApi'
import {
  SettingsBackupService,
  backupNameFor,
  parseBackupName,
  type SettingsFileIO,
} from './settings/settingsBackup'
import { IdleTimeoutService } from './terminal/idleTimeout'
import {
  validateSubAgentSpec,
  runSubAgents,
  renderSubAgentSummary,
} from './AgentHelper/utils/subAgent'
import type { StoredChatSession } from './ChatHistoryService'

/**
 * v3218Comprehensive.extreme.spec — exhaustive tests for the v3.2.18
 * comprehensive-improvement release:
 *   1. Cross-session history search
 *   2. Model failover
 *   3. Sub-agent delegation
 *   4. REST API layer
 *   5. Gateway rate limiting
 *   6. Settings backup/restore
 *   7. Idle terminal timeout
 */

const tests: Array<{ name: string; run: () => void | Promise<void> }> = []
function test(name: string, run: () => void | Promise<void>) { tests.push({ name, run }) }
function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message}. expected=${String(expected)} actual=${String(actual)}`)
}
function assertTrue(actual: boolean, message: string): void {
  if (actual !== true) throw new Error(`${message}. expected=true actual=${String(actual)}`)
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. History search
// ═══════════════════════════════════════════════════════════════════════════

function makeSession(id: string, title: string, messages: Array<{ id: string; type: string; content: unknown }>, updatedAt = Date.now()): StoredChatSession {
  return {
    id, title, updatedAt,
    messages: messages.map((m) => ({ id: m.id, type: m.type, data: { content: m.content } })),
  } as unknown as StoredChatSession
}

test('search: finds matches across sessions, ranked by count', () => {
  const sessions = [
    makeSession('s1', 'cisco work', [{ id: 'm1', type: 'human', content: 'check the bgp config on cisco-xe-1' }]),
    makeSession('s2', 'server work', [
      { id: 'm2', type: 'human', content: 'bgp is down' },
      { id: 'm3', type: 'ai', content: 'the bgp neighbor is flapping' },
      { id: 'm4', type: 'ai', content: 'bgp session restored' },
    ]),
  ]
  const r = searchChatHistory(sessions, 'bgp')
  assertEqual(r.totalSessions, 2, 'both sessions match')
  assertEqual(r.sessions[0].sessionId, 's2', 'more matches ranks first')
  assertEqual(r.sessions[0].matchCount, 3, 's2 has 3 matches')
  assertEqual(r.sessions[1].matchCount, 1, 's1 has 1 match')
})

test('search: case-insensitive', () => {
  const sessions = [makeSession('s1', 't', [{ id: 'm1', type: 'human', content: 'Run BGP Diagnostics' }])]
  const r = searchChatHistory(sessions, 'bgp')
  assertEqual(r.totalMatches, 1, 'found despite case')
})

test('search: title-only match still surfaces the session', () => {
  const sessions = [makeSession('s1', 'Database migration', [{ id: 'm1', type: 'human', content: 'unrelated text' }])]
  const r = searchChatHistory(sessions, 'database')
  assertEqual(r.totalSessions, 1, 'session found by title')
  assertEqual(r.sessions[0].matchCount, 1, 'title hit counted')
  assertEqual(r.sessions[0].matches.length, 0, 'no message snippets')
})

test('search: empty query returns nothing (FP guard)', () => {
  const sessions = [makeSession('s1', 't', [{ id: 'm1', type: 'human', content: 'anything' }])]
  const r = searchChatHistory(sessions, '')
  assertEqual(r.totalSessions, 0, 'no results')
  assertEqual(r.sessions.length, 0, 'empty list')
})

test('search: no match → empty result', () => {
  const sessions = [makeSession('s1', 't', [{ id: 'm1', type: 'human', content: 'nothing here' }])]
  const r = searchChatHistory(sessions, 'zzz-not-present')
  assertEqual(r.totalSessions, 0, 'no results')
})

test('search: session limit truncates and flags', () => {
  const sessions = Array.from({ length: 30 }, (_, i) =>
    makeSession(`s${i}`, `t${i}`, [{ id: 'm1', type: 'human', content: 'needle' }]))
  const r = searchChatHistory(sessions, 'needle', { sessionLimit: 10 })
  assertEqual(r.sessions.length, 10, 'limited to 10')
  assertTrue(r.truncated, 'truncated flag set')
  assertEqual(r.totalSessions, 30, 'total counts all 30')
})

test('search: snippet limit caps matches per session', () => {
  const sessions = [makeSession('s1', 't', Array.from({ length: 10 }, (_, i) =>
    ({ id: `m${i}`, type: 'human', content: 'needle' })))]
  const r = searchChatHistory(sessions, 'needle', { snippetLimit: 2 })
  assertEqual(r.sessions[0].matchCount, 10, 'all 10 counted')
  assertEqual(r.sessions[0].matches.length, 2, 'only 2 snippets')
})

test('search: whole-word mode excludes substrings (FP guard)', () => {
  const sessions = [makeSession('s1', 't', [{ id: 'm1', type: 'human', content: 'the password is hunter2, not a pass' }])]
  const sub = searchChatHistory(sessions, 'pass')
  const word = searchChatHistory(sessions, 'pass', { wholeWord: true })
  // substring mode matches "pass" in "password" AND the standalone "pass"
  assertEqual(sub.totalMatches, 2, 'substring mode matches both')
  // whole-word mode matches ONLY the standalone "pass" (not "password")
  assertEqual(word.totalMatches, 1, 'whole-word mode excludes the substring hit')
})

test('search: includeTitles=false ignores titles', () => {
  const sessions = [makeSession('s1', 'needle title', [{ id: 'm1', type: 'human', content: 'other' }])]
  const r = searchChatHistory(sessions, 'needle', { includeTitles: false })
  assertEqual(r.totalSessions, 0, 'title ignored')
})

test('search: handles multimodal (array) content', () => {
  const sessions = [makeSession('s1', 't', [{
    id: 'm1', type: 'human',
    content: [{ type: 'text', text: 'look at this screenshot' }, { type: 'text', text: 'needle here' }],
  }])]
  const r = searchChatHistory(sessions, 'needle')
  assertEqual(r.totalMatches, 1, 'found in array content')
})

test('search: null/undefined data handled (FP guard)', () => {
  const sessions = [{
    id: 's1', title: 't', updatedAt: 1,
    messages: [{ id: 'm1', type: 'human', data: null }],
  } as unknown as StoredChatSession]
  const r = searchChatHistory(sessions, 'anything')
  assertEqual(r.totalSessions, 0, 'no crash, no results')
})

test('search: extractMessageText handles string, array, and garbage', () => {
  assertEqual(extractMessageText({ content: 'plain' }), 'plain', 'string')
  assertEqual(extractMessageText({ content: [{ text: 'a' }, { text: 'b' }] }), 'a b', 'array')
  assertEqual(extractMessageText({ content: [{ type: 'image_url' }] }), '', 'array without text')
  assertEqual(extractMessageText(null), '', 'null')
  assertEqual(extractMessageText('string'), '', 'non-object')
})

test('search: buildSnippet adds ellipses for mid-text matches', () => {
  const text = 'a'.repeat(200) + 'NEEDLE' + 'b'.repeat(200)
  const s = buildSnippet(text, 200, 6)
  assertTrue(s.startsWith('…'), 'leading ellipsis')
  assertTrue(s.endsWith('…'), 'trailing ellipsis')
  assertTrue(s.includes('NEEDLE'), 'contains the match')
})

test('search: findMatches returns all offsets', () => {
  const hits = findMatches('x foo x foo x foo', 'foo', false)
  assertEqual(hits.length, 3, 'three matches')
  assertEqual(hits[0].offset, 2, 'first offset')
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. Model failover
// ═══════════════════════════════════════════════════════════════════════════

test('failover: rate-limit error is eligible', () => {
  const r = isFailoverEligible(new Error('429 Too Many Requests'))
  assertTrue(r.eligible, 'eligible')
  assertEqual(r.reason, 'rate-limited', 'reason')
})

test('failover: network error is eligible', () => {
  const r = isFailoverEligible(new Error('fetch failed: ECONNREFUSED'))
  assertTrue(r.eligible, 'eligible')
  assertEqual(r.reason, 'network', 'reason')
})

test('failover: 5xx is eligible', () => {
  const r = isFailoverEligible(new Error('502 Bad Gateway from provider'))
  assertTrue(r.eligible, 'eligible')
  assertEqual(r.reason, 'provider-5xx', 'reason')
})

test('failover: auth error is eligible', () => {
  assertTrue(isFailoverEligible(new Error('401 unauthorized: invalid api key')).eligible, 'eligible')
})

test('failover: context-length error is NOT eligible (the request is bad)', () => {
  const r = isFailoverEligible(new Error('context length exceeded: maximum context window'))
  assertTrue(!r.eligible, 'not eligible')
})

test('failover: abort is NOT eligible (user cancelled)', () => {
  const r = isFailoverEligible(new Error('This operation was aborted'))
  assertTrue(!r.eligible, 'not eligible')
})

test('failover: bad request is NOT eligible', () => {
  const r = isFailoverEligible(new Error('400 Bad Request: malformed'))
  assertTrue(!r.eligible, 'not eligible')
})

test('failover: chain dedupes and preserves order', () => {
  const chain = buildFailoverChain(
    { model: 'primary' },
    [{ model: 'a' }, { model: 'primary' }, { model: 'b' }, { model: 'a' }],
  )
  assertEqual(chain.length, 3, 'deduped')
  assertEqual(chain[0].model, 'primary', 'primary first')
  assertEqual(chain[1].model, 'a', 'then a')
  assertEqual(chain[2].model, 'b', 'then b')
})

test('failover: no fallbacks → chain of one', () => {
  assertEqual(buildFailoverChain({ model: 'x' }, undefined).length, 1, 'one')
  assertEqual(buildFailoverChain({ model: 'x' }, []).length, 1, 'one')
})

test('failover: succeeds on first model → no fallback tried', async () => {
  const tried: string[] = []
  const r = await withModelFailover([{ model: 'a' }, { model: 'b' }], async (m) => {
    tried.push(m.model)
    return 'ok'
  })
  assertEqual(tried.length, 1, 'one attempt')
  assertEqual(r.usedModel, 'a', 'used a')
  assertTrue(r.value === 'ok', 'value')
})

test('failover: first fails (eligible) → second succeeds', async () => {
  const tried: string[] = []
  const r = await withModelFailover([{ model: 'a' }, { model: 'b' }], async (m) => {
    tried.push(m.model)
    if (m.model === 'a') throw new Error('429 rate limited')
    return 'recovered'
  })
  assertEqual(tried.join(','), 'a,b', 'both tried')
  assertEqual(r.usedModel, 'b', 'used b')
  assertEqual(r.value, 'recovered', 'value')
  assertEqual(r.attempts.length, 2, 'two attempts recorded')
  assertTrue(!r.attempts[0].ok, 'first failed')
  assertTrue(r.attempts[1].ok, 'second ok')
})

test('failover: ineligible error stops the chain immediately', async () => {
  const tried: string[] = []
  const r = await withModelFailover([{ model: 'a' }, { model: 'b' }], async (m) => {
    tried.push(m.model)
    throw new Error('context length exceeded')
  })
  assertEqual(tried.length, 1, 'only one attempt')
  assertTrue(r.error !== undefined, 'error returned')
})

test('failover: all fail → last error returned', async () => {
  const r = await withModelFailover([{ model: 'a' }, { model: 'b' }], async () => {
    throw new Error('network down')
  })
  assertEqual(r.attempts.length, 2, 'both tried')
  assertTrue(r.error !== undefined, 'error present')
  assertTrue(r.usedModel === undefined, 'no success')
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. Sub-agents
// ═══════════════════════════════════════════════════════════════════════════

test('subagent: valid spec passes validation', () => {
  const v = validateSubAgentSpec({ tasks: [{ label: 'a', prompt: 'do x' }] })
  assertTrue(v.ok, 'valid')
})

test('subagent: empty tasks rejected', () => {
  assertTrue(!validateSubAgentSpec({ tasks: [] }).ok, 'empty rejected')
})

test('subagent: missing prompt rejected', () => {
  assertTrue(!validateSubAgentSpec({ tasks: [{ label: 'a' }] }).ok, 'no prompt rejected')
  assertTrue(!validateSubAgentSpec({ tasks: [{ label: 'a', prompt: '  ' }] }).ok, 'whitespace prompt rejected')
})

test('subagent: >20 tasks rejected (runaway guard)', () => {
  const tasks = Array.from({ length: 21 }, (_, i) => ({ label: `t${i}`, prompt: 'x' }))
  assertTrue(!validateSubAgentSpec({ tasks }).ok, '21 rejected')
  assertTrue(validateSubAgentSpec({ tasks: tasks.slice(0, 20) }).ok, '20 ok')
})

test('subagent: bad maxConcurrent/timeout rejected', () => {
  assertTrue(!validateSubAgentSpec({ tasks: [{ prompt: 'x' }], maxConcurrent: 0 }).ok, '0 rejected')
  assertTrue(!validateSubAgentSpec({ tasks: [{ prompt: 'x' }], timeoutMs: 100 }).ok, '100ms rejected')
})

test('subagent: all succeed → ok summary', async () => {
  const r = await runSubAgents(
    { tasks: [{ label: 'a', prompt: 'x' }, { label: 'b', prompt: 'y' }] },
    async (t) => `done ${t.label}`,
  )
  assertTrue(r.ok, 'ok')
  assertEqual(r.succeeded, 2, 'both succeeded')
  assertEqual(r.results[0].output, 'done a', 'output captured')
})

test('subagent: one fails → summary not ok, others still collected', async () => {
  const r = await runSubAgents(
    { tasks: [{ label: 'a', prompt: 'x' }, { label: 'b', prompt: 'y' }] },
    async (t) => { if (t.label === 'a') throw new Error('child blew up'); return 'ok' },
  )
  assertTrue(!r.ok, 'not ok')
  assertEqual(r.succeeded, 1, 'one succeeded')
  assertEqual(r.failed, 1, 'one failed')
  assertEqual(r.results[0].error, 'child blew up', 'error captured')
})

test('subagent: timeout kills a slow child', async () => {
  const r = await runSubAgents(
    { tasks: [{ label: 'slow', prompt: 'x' }], timeoutMs: 1000 },
    async () => { await new Promise((res) => setTimeout(res, 5000)); return 'late' },
  )
  assertEqual(r.succeeded, 0, 'did not succeed')
  assertTrue(r.results[0].timedOut, 'timedOut flag')
  assertEqual(r.results[0].error, 'timed out', 'error')
})

test('subagent: concurrency cap respected', async () => {
  let running = 0
  let peak = 0
  const r = await runSubAgents(
    {
      tasks: Array.from({ length: 6 }, (_, i) => ({ label: `t${i}`, prompt: 'x' })),
      maxConcurrent: 2,
    },
    async () => {
      running++
      peak = Math.max(peak, running)
      await new Promise((res) => setTimeout(res, 30))
      running--
      return 'ok'
    },
  )
  assertEqual(r.succeeded, 6, 'all succeeded')
  assertTrue(peak <= 2, `concurrency capped at 2 (peak ${peak})`)
})

test('subagent: render includes status markers', () => {
  const text = renderSubAgentSummary({
    ok: false, total: 2, succeeded: 1, failed: 1,
    results: [
      { label: 'good', ok: true, output: 'all clear', durationMs: 100, timedOut: false },
      { label: 'bad', ok: false, error: 'nope', durationMs: 50, timedOut: false },
    ],
  })
  assertTrue(text.includes('1/2 succeeded'), 'summary line')
  assertTrue(text.includes('✓ good'), 'success marker')
  assertTrue(text.includes('✗ bad'), 'failure marker')
  assertTrue(text.includes('1 task(s) failed'), 'failure note')
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. REST API
// ═══════════════════════════════════════════════════════════════════════════

const routes = defaultRestRoutes()

test('rest: matches a static GET route', () => {
  const m = matchRestRoute(routes, 'GET', '/api/v1/health')
  assertTrue(m !== null, 'matched')
  assertEqual(m!.route.gatewayMethod, 'gateway:ping', 'method')
})

test('rest: matches a parameterized route and extracts the param', () => {
  const m = matchRestRoute(routes, 'POST', '/api/v1/sessions/abc-123/chat')
  assertTrue(m !== null, 'matched')
  assertEqual(m!.pathParams.id, 'abc-123', 'param extracted')
  assertEqual(m!.route.gatewayMethod, 'agent:startTask', 'method')
})

test('rest: method mismatch → no match', () => {
  assertEqual(matchRestRoute(routes, 'GET', '/api/v1/sessions/abc/chat'), null, 'GET on POST route')
})

test('rest: unknown path → no match', () => {
  assertEqual(matchRestRoute(routes, 'GET', '/api/v1/nonexistent'), null, 'no match')
})

test('rest: trailing slash tolerated', () => {
  const m = matchRestRoute(routes, 'GET', '/api/v1/health/')
  assertTrue(m !== null, 'matched despite trailing slash')
})

test('rest: URL-encoded params decoded', () => {
  const m = matchRestRoute(routes, 'POST', '/api/v1/sessions/my%20session/chat')
  assertTrue(m !== null, 'matched')
  assertEqual(m!.pathParams.id, 'my session', 'decoded')
})

test('rest: dispatches to the gateway method with built params', async () => {
  const calls: Array<{ method: string; params: unknown }> = []
  const r = await handleRestRequest(routes, async (method, params) => {
    calls.push({ method, params })
    return { pong: true }
  }, { method: 'GET', path: '/api/v1/health' })
  assertEqual(r.status, 200, 'status')
  assertEqual(calls[0].method, 'gateway:ping', 'dispatched')
})

test('rest: chat route builds userInput from body', async () => {
  const calls: Array<{ method: string; params: unknown }> = []
  await handleRestRequest(routes, async (method, params) => {
    calls.push({ method, params })
    return {}
  }, { method: 'POST', path: '/api/v1/sessions/s1/chat', body: { message: 'hello there' } })
  assertEqual(calls[0].method, 'agent:startTask', 'method')
  const p = calls[0].params as { sessionId: string; userInput: string }
  assertEqual(p.sessionId, 's1', 'sessionId from path')
  assertEqual(p.userInput, 'hello there', 'message from body')
})

test('rest: /rpc escape hatch dispatches any method', async () => {
  const calls: Array<{ method: string; params: unknown }> = []
  const r = await handleRestRequest(routes, async (method, params) => {
    calls.push({ method, params })
    return { ok: true }
  }, { method: 'POST', path: '/api/v1/rpc', body: { method: 'terminal:list', params: { x: 1 } } })
  assertEqual(r.status, 200, 'status')
  assertEqual(calls[0].method, 'terminal:list', 'dispatched')
})

test('rest: /rpc without a method → 400', async () => {
  const r = await handleRestRequest(routes, async () => ({}), {
    method: 'POST', path: '/api/v1/rpc', body: {},
  })
  assertEqual(r.status, 400, 'bad request')
})

test('rest: unknown route → 404', async () => {
  const r = await handleRestRequest(routes, async () => ({}), { method: 'GET', path: '/nope' })
  assertEqual(r.status, 404, 'not found')
})

test('rest: gateway error → 500 with message', async () => {
  const r = await handleRestRequest(routes, async () => {
    throw new Error('internal explosion')
  }, { method: 'GET', path: '/api/v1/health' })
  assertEqual(r.status, 500, 'server error')
  const b = r.body as { error: string; message: string }
  assertEqual(b.error, 'gateway_error', 'error code')
  assertTrue(b.message.includes('explosion'), 'message')
})

test('rest: "not found" gateway error → 404 (not 500)', async () => {
  const r = await handleRestRequest(routes, async () => {
    throw new Error('no terminal tab "ghost"')
  }, { method: 'GET', path: '/api/v1/terminals' })
  assertEqual(r.status, 404, 'mapped to 404')
})

// ═══════════════════════════════════════════════════════════════════════════
// 5. Rate limiting
// ═══════════════════════════════════════════════════════════════════════════

function makeClock(start = 0) {
  let t = start
  return { now: () => t, advance: (ms: number) => { t += ms } }
}

test('ratelimit: allows within capacity', () => {
  const clock = makeClock()
  const rl = new GatewayRateLimiter({ capacity: 5, refillPerSecond: 0, now: clock.now })
  for (let i = 0; i < 5; i++) {
    const d = rl.check('client-a')
    assertTrue(d.allowed, `request ${i + 1} allowed`)
  }
})

test('ratelimit: denies past capacity', () => {
  const clock = makeClock()
  const rl = new GatewayRateLimiter({ capacity: 3, refillPerSecond: 0, now: clock.now })
  for (let i = 0; i < 3; i++) rl.check('client-a')
  const d = rl.check('client-a')
  assertTrue(!d.allowed, 'denied')
  assertEqual(d.reason, 'rate-limited', 'reason')
})

test('ratelimit: tokens refill over time', () => {
  const clock = makeClock()
  const rl = new GatewayRateLimiter({ capacity: 2, refillPerSecond: 1, now: clock.now })
  rl.check('a'); rl.check('a')
  assertTrue(!rl.check('a').allowed, 'empty')
  clock.advance(1000) // 1 token refilled
  assertTrue(rl.check('a').allowed, 'refilled')
})

test('ratelimit: refill caps at capacity', () => {
  const clock = makeClock()
  const rl = new GatewayRateLimiter({ capacity: 2, refillPerSecond: 10, now: clock.now })
  rl.check('a'); rl.check('a')
  clock.advance(60_000) // would refill 600 tokens
  assertTrue(rl.check('a').allowed, 'one')
  assertTrue(rl.check('a').allowed, 'two')
  assertTrue(!rl.check('a').allowed, 'capped at 2')
})

test('ratelimit: clients are independent', () => {
  const clock = makeClock()
  const rl = new GatewayRateLimiter({ capacity: 1, refillPerSecond: 0, now: clock.now })
  assertTrue(rl.check('a').allowed, 'a ok')
  assertTrue(!rl.check('a').allowed, 'a denied')
  assertTrue(rl.check('b').allowed, 'b unaffected')
})

test('ratelimit: auth failures lock out after the limit', () => {
  const clock = makeClock()
  const rl = new GatewayRateLimiter({ authFailureLimit: 3, authLockoutMs: 60_000, now: clock.now })
  rl.recordAuthFailure('attacker')
  rl.recordAuthFailure('attacker')
  assertTrue(!rl.isLockedOut('attacker'), 'not yet')
  const d = rl.recordAuthFailure('attacker')
  assertTrue(!d.allowed, 'third failure locks out')
  assertEqual(d.reason, 'locked-out', 'reason')
  assertTrue(rl.isLockedOut('attacker'), 'locked out')
})

test('ratelimit: lockout expires', () => {
  const clock = makeClock()
  const rl = new GatewayRateLimiter({ authFailureLimit: 2, authLockoutMs: 1000, now: clock.now })
  rl.recordAuthFailure('a'); rl.recordAuthFailure('a')
  assertTrue(rl.isLockedOut('a'), 'locked')
  clock.advance(1500)
  assertTrue(!rl.isLockedOut('a'), 'lockout expired')
})

test('ratelimit: successful auth clears failures', () => {
  const clock = makeClock()
  const rl = new GatewayRateLimiter({ authFailureLimit: 3, now: clock.now })
  rl.recordAuthFailure('a')
  rl.recordAuthFailure('a')
  rl.recordAuthSuccess('a')
  rl.recordAuthFailure('a')
  assertTrue(!rl.isLockedOut('a'), 'counter reset by success')
})

test('ratelimit: forget drops all state', () => {
  const clock = makeClock()
  const rl = new GatewayRateLimiter({ capacity: 1, refillPerSecond: 0, now: clock.now })
  rl.check('a')
  assertEqual(rl.clientCount, 1, 'tracked')
  rl.forget('a')
  assertEqual(rl.clientCount, 0, 'forgotten')
  assertTrue(rl.check('a').allowed, 'fresh bucket after forget')
})

// ═══════════════════════════════════════════════════════════════════════════
// 6. Settings backup
// ═══════════════════════════════════════════════════════════════════════════

function makeBackupIO(initial = '{"v":1}') {
  const backups = new Map<string, string>()
  let current = initial
  return {
    read: () => current,
    write: (c: string) => { current = c },
    listBackups: () => [...backups.keys()],
    readBackup: (n: string) => backups.get(n) ?? '',
    writeBackup: (n: string, c: string) => { backups.set(n, c) },
    deleteBackup: (n: string) => { backups.delete(n) },
  } satisfies SettingsFileIO
}

test('backup: name round-trips through parse', () => {
  const d = new Date('2026-08-26T14:30:45Z')
  const name = backupNameFor(d)
  assertEqual(name, 'settings-backup-20260826-143045.json', 'name format')
  const parsed = parseBackupName(name)
  assertTrue(parsed !== null, 'parsed')
  assertEqual(parsed!.getTime(), d.getTime(), 'round-trip')
})

test('backup: parse rejects garbage (FP guard)', () => {
  assertEqual(parseBackupName('random.json'), null, 'no prefix')
  assertEqual(parseBackupName('settings-backup-notadate.json'), null, 'bad date')
  assertEqual(parseBackupName(''), null, 'empty')
})

test('backup: creates a backup of current settings', () => {
  const io = makeBackupIO('{"v":1}')
  const svc = new SettingsBackupService(io, { now: () => new Date('2026-08-26T10:00:00Z') })
  const rec = svc.backup()
  assertEqual(rec.size, '{"v":1}'.length, 'size matches content length')
  assertEqual(io.listBackups().length, 1, 'one backup')
  assertEqual(io.readBackup(rec.name), '{"v":1}', 'content preserved')
})

test('backup: rotation keeps only the newest N', () => {
  const io = makeBackupIO()
  let t = new Date('2026-08-26T10:00:00Z').getTime()
  const svc = new SettingsBackupService(io, { keep: 3, now: () => new Date(t) })
  for (let i = 0; i < 6; i++) {
    svc.backup()
    t += 60_000
  }
  assertEqual(io.listBackups().length, 3, 'only 3 kept')
  const list = svc.list()
  assertEqual(list.length, 3, 'list shows 3')
  assertTrue(list[0].at.getTime() > list[2].at.getTime(), 'newest first')
})

test('backup: restore writes the backup content to live settings', () => {
  const io = makeBackupIO()
  let t = new Date('2026-08-26T10:00:00Z').getTime()
  const svc = new SettingsBackupService(io, { now: () => new Date(t) })
  io.write('{"v":"old"}')
  svc.backup() // backs up {"v":"old"}
  t += 60_000
  io.write('{"v":"new"}')
  const list = svc.list()
  const r = svc.restore(list[0].name)
  assertTrue(r.ok, 'restored')
  assertEqual(io.read(), '{"v":"old"}', 'old content restored')
})

test('backup: restore of unknown name fails cleanly', () => {
  const io = makeBackupIO()
  const svc = new SettingsBackupService(io)
  const r = svc.restore('nope.json')
  assertTrue(!r.ok, 'failed')
  assertTrue(String(r.error).includes('no backup'), 'error message')
})

test('backup: restore takes a safety backup first', () => {
  const io = makeBackupIO()
  let t = new Date('2026-08-26T10:00:00Z').getTime()
  const svc = new SettingsBackupService(io, { now: () => new Date(t) })
  io.write('{"v":1}')
  svc.backup() // backup-1 of {"v":1}
  t += 60_000
  io.write('{"v":2}')
  const first = svc.list()[0].name
  svc.restore(first) // should back up {"v":2} before writing {"v":1}
  assertEqual(io.read(), '{"v":1}', 'restored v1')
  assertTrue(io.listBackups().some((n) => io.readBackup(n) === '{"v":2}'), 'v2 was safety-backed-up')
})

test('backup: export returns current content', () => {
  const io = makeBackupIO('{"exported":true}')
  const svc = new SettingsBackupService(io)
  assertEqual(svc.export(), '{"exported":true}', 'exported')
})

test('backup: import validates JSON', () => {
  const io = makeBackupIO()
  const svc = new SettingsBackupService(io)
  assertTrue(!svc.import('not json').ok, 'invalid JSON rejected')
  assertTrue(!svc.import('').ok, 'empty rejected')
  assertTrue(!svc.import('[1,2,3]').ok, 'array rejected')
  assertTrue(!svc.import('"string"').ok, 'string rejected')
})

test('backup: import of valid object replaces settings (with safety backup)', () => {
  const io = makeBackupIO('{"v":"original"}')
  let t = new Date('2026-08-26T10:00:00Z').getTime()
  const svc = new SettingsBackupService(io, { now: () => new Date(t) })
  const r = svc.import('{"v":"imported"}')
  assertTrue(r.ok, 'imported')
  assertEqual(io.read(), '{"v":"imported"}', 'replaced')
  assertTrue(io.listBackups().some((n) => io.readBackup(n) === '{"v":"original"}'), 'original backed up')
})

// ═══════════════════════════════════════════════════════════════════════════
// 7. Idle timeout
// ═══════════════════════════════════════════════════════════════════════════

test('idle: not idle before the threshold', () => {
  const clock = makeClock()
  const svc = new IdleTimeoutService({ idleMinutes: 30, now: clock.now })
  svc.register('t1')
  clock.advance(29 * 60_000)
  assertTrue(!svc.isIdle('t1'), '29 min is not idle')
})

test('idle: idle after the threshold', () => {
  const clock = makeClock()
  const svc = new IdleTimeoutService({ idleMinutes: 30, now: clock.now })
  svc.register('t1')
  clock.advance(30 * 60_000)
  assertTrue(svc.isIdle('t1'), '30 min is idle')
})

test('idle: touch resets the clock', () => {
  const clock = makeClock()
  const svc = new IdleTimeoutService({ idleMinutes: 30, now: clock.now })
  svc.register('t1')
  clock.advance(25 * 60_000)
  svc.touch('t1')
  clock.advance(25 * 60_000)
  assertTrue(!svc.isIdle('t1'), '50 min since register but only 25 since touch')
})

test('idle: protected ids never idle', () => {
  const clock = makeClock()
  const svc = new IdleTimeoutService({ idleMinutes: 1, protectedIds: ['local-main'], now: clock.now })
  svc.register('local-main')
  clock.advance(60 * 60_000)
  assertTrue(!svc.isIdle('local-main'), 'protected')
})

test('idle: unregistered terminal is never idle (FP guard)', () => {
  const clock = makeClock()
  const svc = new IdleTimeoutService({ idleMinutes: 1, now: clock.now })
  clock.advance(999_999)
  assertTrue(!svc.isIdle('unknown'), 'unknown terminal not idle')
})

test('idle: idleTerminals lists only idle ones', () => {
  const clock = makeClock()
  const svc = new IdleTimeoutService({ idleMinutes: 10, now: clock.now })
  svc.register('a'); svc.register('b'); svc.register('c')
  clock.advance(5 * 60_000)
  svc.touch('b')
  clock.advance(6 * 60_000) // a,c idle 11min; b idle 6min
  const idle = svc.idleTerminals(['a', 'b', 'c'])
  assertEqual(idle.length, 2, 'two idle')
  const ids = idle.map((x) => x.terminalId).sort()
  assertEqual(ids.join(','), 'a,c', 'a and c')
})

test('idle: forget removes tracking', () => {
  const clock = makeClock()
  const svc = new IdleTimeoutService({ idleMinutes: 1, now: clock.now })
  svc.register('t1')
  svc.forget('t1')
  clock.advance(60 * 60_000)
  assertEqual(svc.idleTerminals(['t1']).length, 0, 'forgotten')
})

test('idle: threshold adjustable at runtime', () => {
  const clock = makeClock()
  const svc = new IdleTimeoutService({ idleMinutes: 60, now: clock.now })
  svc.register('t1')
  clock.advance(15 * 60_000)
  assertTrue(!svc.isIdle('t1'), 'not idle at 15min with 60min threshold')
  svc.setIdleMinutes(10)
  assertTrue(svc.isIdle('t1'), 'idle after lowering to 10min')
  assertEqual(svc.idleMinutes, 10, 'getter reflects')
})

// ─── Runner ─────────────────────────────────────────────────────────────────

async function main() {
  let pass = 0, fail = 0
  for (const t of tests) {
    try { await t.run(); pass++; console.log(`PASS ${t.name}`) }
    catch (e) { fail++; console.log(`FAIL ${t.name}: ${(e as Error).message}`) }
  }
  console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}
void main()
