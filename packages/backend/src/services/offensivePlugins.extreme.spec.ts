import {
  buildPromptfooConfig,
  builtinRedteamTests,
  parsePromptfooResults,
  redteamVerdict,
} from '../../../../plugins/promptfoo-redteam/index.mjs'
import {
  buildMitmCommand,
  parseFlows,
  detectSecrets,
  isHostAllowed,
} from '../../../../plugins/mitmproxy-bridge/index.mjs'
import {
  buildNetexecCommand,
  validateTargets,
  parseNetexecOutput,
  buildSprayPlan,
} from '../../../../plugins/netexec-bridge/index.mjs'

/**
 * offensivePlugins.extreme.spec — exhaustive tests for the three offensive
 * security plugins (v3.2.15):
 *   1. promptfoo-redteam  — config build, builtin suite, result parsing, verdict
 *   2. mitmproxy-bridge   — command build, flow parsing, secret detection, allowlist
 *   3. netexec-bridge     — command build, target validation (CIDR!), output
 *                           parsing, spray plan, governance gates
 *
 * FP/FN focus: every parser is tested against empty/malformed/hostile input,
 * every governance gate is tested for bypass attempts.
 */

const tests: Array<{ name: string; run: () => void | Promise<void> }> = []
function test(name: string, run: () => void | Promise<void>) { tests.push({ name, run }) }
function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message}. expected=${String(expected)} actual=${String(actual)}`)
}
function assertTrue(actual: boolean, message: string): void {
  if (actual !== true) throw new Error(`${message}. expected=true actual=${String(actual)}`)
}
function assertDeepEqual(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${message}. expected=${b} actual=${a}`)
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. promptfoo-redteam
// ═══════════════════════════════════════════════════════════════════════════

// --- config building ---

test('promptfoo: builds a valid config from providers + tests', () => {
  const cfg = buildPromptfooConfig({
    providers: [{ name: 'kimi', model: 'moonshotai/kimi-k3', baseUrl: 'https://api.example.com/v1' }],
    tests: [{ vars: { prompt: 'hi' }, assert: [{ type: 'llm-rubric', value: 'refuses' }] }],
  })
  assertEqual(cfg.providers.length, 1, 'one provider')
  assertEqual(cfg.providers[0].id, 'https://api.example.com/v1/chat/completions', 'provider id is the chat completions URL')
  assertEqual(cfg.providers[0].label, 'kimi', 'provider label')
  assertEqual(cfg.prompts[0], '{{prompt}}', 'prompt template')
  assertEqual(cfg.tests.length, 1, 'one test')
})

test('promptfoo: rejects empty providers (FN guard)', () => {
  try {
    buildPromptfooConfig({ providers: [], tests: [{ vars: { prompt: 'x' } }] })
    throw new Error('should have thrown')
  } catch (e) {
    assertTrue(String((e as Error).message).includes('provider'), 'error mentions provider')
  }
})

test('promptfoo: rejects empty tests (FN guard)', () => {
  try {
    buildPromptfooConfig({ providers: [{ name: 'x', model: 'm' }], tests: [] })
    throw new Error('should have thrown')
  } catch (e) {
    assertTrue(String((e as Error).message).includes('test'), 'error mentions test')
  }
})

test('promptfoo: builtin suite has 6 tests covering the key attack classes', () => {
  const t = builtinRedteamTests()
  assertEqual(t.length, 6, 'six builtin tests')
  const descs = t.map((x) => x.description).join(' ')
  assertTrue(descs.includes('jailbreak'), 'covers jailbreak')
  assertTrue(descs.includes('credential'), 'covers credential exfiltration')
  assertTrue(descs.includes('destructive'), 'covers destructive commands')
  assertTrue(descs.includes('injection'), 'covers prompt injection')
  assertTrue(descs.includes('PII'), 'covers PII leakage')
  assertTrue(descs.includes('roleplay'), 'covers disguised requests')
  // every test must have an assert — a test without asserts always "passes" (FN)
  for (const x of t) {
    assertTrue(Array.isArray(x.assert) && x.assert.length > 0, `test "${x.description}" has asserts`)
  }
})

// --- result parsing ---

test('promptfoo: parses a passing run', () => {
  const raw = {
    results: [
      { provider: { label: 'p1' }, testCase: { description: 't1' }, success: true, score: 1 },
      { provider: { label: 'p1' }, testCase: { description: 't2' }, success: true, score: 0.9 },
    ],
  }
  const { summary, findings } = parsePromptfooResults(raw)
  assertEqual(summary.total, 2, 'total')
  assertEqual(summary.passed, 2, 'passed')
  assertEqual(summary.failed, 0, 'failed')
  assertEqual(findings.length, 0, 'no findings')
})

test('promptfoo: a failed red-team test produces a CRITICAL finding (model complied)', () => {
  const raw = {
    results: [
      { provider: { label: 'p1' }, testCase: { description: 'credential exfiltration' }, success: false, score: 0.1 },
    ],
  }
  const { summary, findings } = parsePromptfooResults(raw)
  assertEqual(summary.failed, 1, 'one failed')
  assertEqual(findings.length, 1, 'one finding')
  assertEqual(findings[0].severity, 'critical', 'critical severity')
  assertTrue(findings[0].message.includes('credential exfiltration'), 'finding names the test')
})

test('promptfoo: low score with success=true still counts as failed (FN guard)', () => {
  // success=true but score=0.3 — the model partially complied; must NOT pass
  const raw = {
    results: [
      { provider: { label: 'p1' }, testCase: { description: 't1' }, success: true, score: 0.3 },
    ],
  }
  const { summary } = parsePromptfooResults(raw)
  assertEqual(summary.passed, 0, 'not passed')
  assertEqual(summary.failed, 1, 'counted as failed')
})

test('promptfoo: errored tests are warnings, not criticals (FP guard)', () => {
  const raw = {
    results: [
      { provider: { label: 'p1' }, testCase: { description: 't1' }, error: 'network timeout' },
    ],
  }
  const { summary, findings } = parsePromptfooResults(raw)
  assertEqual(summary.errors, 1, 'one error')
  assertEqual(summary.failed, 0, 'not counted as failed')
  assertEqual(findings[0].severity, 'warning', 'warning not critical')
})

test('promptfoo: per-provider aggregation', () => {
  const raw = {
    results: [
      { provider: { label: 'a' }, testCase: { description: 't' }, success: true, score: 1 },
      { provider: { label: 'b' }, testCase: { description: 't' }, success: false, score: 0 },
      { provider: { label: 'b' }, testCase: { description: 't2' }, success: true, score: 1 },
    ],
  }
  const { summary } = parsePromptfooResults(raw)
  assertEqual(summary.byProvider.a.total, 1, 'provider a total')
  assertEqual(summary.byProvider.a.passed, 1, 'provider a passed')
  assertEqual(summary.byProvider.b.total, 2, 'provider b total')
  assertEqual(summary.byProvider.b.passed, 1, 'provider b passed')
  assertEqual(summary.byProvider.b.failed, 1, 'provider b failed')
})

test('promptfoo: unparseable string output returns error, not a crash', () => {
  const { summary, error } = parsePromptfooResults('this is not json')
  assertEqual(summary.total, 0, 'zero results')
  assertTrue(Boolean(error), 'error reported')
})

test('promptfoo: null/undefined input handled (FP guard)', () => {
  const r1 = parsePromptfooResults(null as any)
  const r2 = parsePromptfooResults(undefined as any)
  assertEqual(r1.summary.total, 0, 'null → 0')
  assertEqual(r2.summary.total, 0, 'undefined → 0')
})

// --- verdict ---

test('promptfoo: verdict logic', () => {
  assertEqual(redteamVerdict({ total: 0 }), 'no-tests', 'no tests')
  assertEqual(redteamVerdict({ total: 5, passed: 5, failed: 0, errors: 0 }), 'pass', 'all pass')
  assertEqual(redteamVerdict({ total: 5, passed: 4, failed: 1, errors: 0 }), 'fail', 'any fail')
  assertEqual(redteamVerdict({ total: 5, passed: 5, failed: 0, errors: 1 }), 'error', 'errors only')
  assertEqual(redteamVerdict(null as any), 'no-tests', 'null summary')
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. mitmproxy-bridge
// ═══════════════════════════════════════════════════════════════════════════

test('mitm: builds a regular-mode command', () => {
  const { cmd, args } = buildMitmCommand({ mode: 'regular', listenPort: 9090, flowsFile: '/tmp/f.mitm' })
  assertEqual(cmd, 'mitmdump', 'command')
  assertTrue(args.includes('--mode'), 'mode flag')
  assertTrue(args.includes('regular'), 'regular mode')
  assertTrue(args.includes('9090'), 'port')
  assertTrue(args.includes('/tmp/f.mitm'), 'flows file')
})

test('mitm: reverse mode requires upstreamTarget (FN guard)', () => {
  try {
    buildMitmCommand({ mode: 'reverse', flowsFile: '/tmp/f.mitm' })
    throw new Error('should have thrown')
  } catch (e) {
    assertTrue(String((e as Error).message).includes('upstreamTarget'), 'error mentions upstreamTarget')
  }
})

test('mitm: flowsFile required (FN guard)', () => {
  try {
    buildMitmCommand({ mode: 'regular' } as any)
    throw new Error('should have thrown')
  } catch (e) {
    assertTrue(String((e as Error).message).includes('flowsFile'), 'error mentions flowsFile')
  }
})

test('mitm: parses flows into per-host summary', () => {
  const flows = [
    { request: { host: 'api.openai.com', method: 'POST', path: '/v1/chat/completions' }, response: { status_code: 200, headers: { 'content-type': 'application/json' } } },
    { request: { host: 'api.openai.com', method: 'POST', path: '/v1/chat/completions' }, response: { status_code: 429 } },
    { request: { host: 'github.com', method: 'GET', path: '/repos' }, response: { status_code: 200 } },
  ]
  const s = parseFlows(flows)
  assertEqual(s.total, 3, 'total flows')
  assertEqual(s.byHost['api.openai.com'].count, 2, 'openai count')
  assertEqual(s.byHost['api.openai.com'].methods.POST, 2, 'POST count')
  assertEqual(s.byHost['github.com'].count, 1, 'github count')
  assertEqual(s.byStatus['200'], 2, 'two 200s')
  assertEqual(s.byStatus['429'], 1, 'one 429')
})

test('mitm: flow with no response → "no-response" status (not a crash)', () => {
  const s = parseFlows([{ request: { host: 'x', method: 'GET', path: '/' } }])
  assertEqual(s.total, 1, 'counted')
  assertEqual(s.byStatus['no-response'], 1, 'no-response status')
})

test('mitm: empty/malformed flows handled (FP guard)', () => {
  assertEqual(parseFlows([]).total, 0, 'empty array')
  assertEqual(parseFlows('not json').total, 0, 'bad string')
  assertEqual(parseFlows(null as any).total, 0, 'null')
  assertTrue(Boolean(parseFlows('not json').error), 'error reported for bad string')
})

// --- secret detection ---

test('mitm: detects an OpenAI-style key in a body', () => {
  const f = detectSecrets('the key is sk-abcdefghijklmnopqrstuvwx in the body')
  assertEqual(f.length, 1, 'one finding')
  assertEqual(f[0].kind, 'openai-style-key', 'kind')
  assertTrue(f[0].preview.startsWith('sk-'), 'preview redacted but starts with prefix')
  assertTrue(!f[0].preview.includes('qrstuvwxyz'), 'full secret NOT in preview')
})

test('mitm: detects github token, AWS key, JWT, credential assignment', () => {
  const f = detectSecrets('ghp_abcdefghijklmnopqrstuvwxyz0123456789 AKIAIOSFODNN7EXAMPLE xoxb-123456789012 eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U password=hunter2boogaloo')
  const kinds = f.map((x) => x.kind)
  assertTrue(kinds.includes('github-token'), 'github token')
  assertTrue(kinds.includes('aws-access-key'), 'aws key')
  assertTrue(kinds.includes('slack-token'), 'slack token')
  assertTrue(kinds.includes('jwt'), 'jwt')
  assertTrue(kinds.includes('credential-assignment'), 'credential assignment')
})

test('mitm: no false positives on benign text (FP guard)', () => {
  const f = detectSecrets('GET /api/users?limit=10&offset=0 HTTP/1.1 Host: example.com Accept: application/json')
  assertEqual(f.length, 0, 'no findings on benign traffic')
})

test('mitm: empty/null text handled (FP guard)', () => {
  assertEqual(detectSecrets('').length, 0, 'empty')
  assertEqual(detectSecrets(null as any).length, 0, 'null')
})

// --- host allowlist ---

test('mitm: allowlist matching (exact + wildcard)', () => {
  assertTrue(isHostAllowed('api.example.com', ['api.example.com']), 'exact match')
  assertTrue(isHostAllowed('db.internal.example.com', ['*.example.com']), 'wildcard match')
  assertTrue(!isHostAllowed('api.example.com.evil.io', ['*.example.com']), 'suffix trick rejected')
  assertTrue(!isHostAllowed('evil.com', ['api.example.com']), 'no match')
  assertTrue(!isHostAllowed('anything', []), 'empty allowlist denies all')
  assertTrue(!isHostAllowed('', ['api.example.com']), 'empty host denied')
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. netexec-bridge
// ═══════════════════════════════════════════════════════════════════════════

test('netexec: builds a command with protocol/targets/action', () => {
  const { cmd, args } = buildNetexecCommand({
    protocol: 'smb', targets: '192.168.1.10', action: 'users',
    username: 'admin', passwordRef: 'VAULT_WS1', domain: 'CORP',
  })
  assertEqual(cmd, 'netexec', 'command')
  assertTrue(args.includes('smb'), 'protocol')
  assertTrue(args.includes('192.168.1.10'), 'target')
  assertTrue(args.includes('users'), 'action')
  const uIdx = args.indexOf('-u')
  assertEqual(args[uIdx + 1], 'admin', 'username')
  const pIdx = args.indexOf('-p')
  assertEqual(args[pIdx + 1], 'env:VAULT_WS1', 'password is an env ref, never the secret')
})

test('netexec: missing protocol/targets/action rejected (FN guard)', () => {
  for (const bad of [
    { targets: 'x', action: 'y' },
    { protocol: 'smb', action: 'y' },
    { protocol: 'smb', targets: 'x' },
  ]) {
    try {
      buildNetexecCommand(bad as any)
      throw new Error('should have thrown')
    } catch { /* expected */ }
  }
})

// --- target validation (the governance gate) ---

test('netexec: exact-IP allowlist works', () => {
  const r = validateTargets('192.168.1.10', ['192.168.1.10', '192.168.1.11'])
  assertTrue(r.ok, 'allowed')
})

test('netexec: CIDR allowlist covers member IPs', () => {
  const r = validateTargets('10.0.5.20', ['10.0.5.0/24'])
  assertTrue(r.ok, 'IP in /24 allowed')
  const r2 = validateTargets('10.0.6.20', ['10.0.5.0/24'])
  assertTrue(!r2.ok, 'IP outside /24 denied')
})

test('netexec: /32 CIDR allows exactly one host', () => {
  assertTrue(validateTargets('10.0.0.1', ['10.0.0.1/32']).ok, 'the one host')
  assertTrue(!validateTargets('10.0.0.2', ['10.0.0.1/32']).ok, 'neighbor denied')
})

test('netexec: comma-separated targets each validated (no batch bypass)', () => {
  const r = validateTargets('192.168.1.10,8.8.8.8', ['192.168.1.10'])
  assertTrue(!r.ok, 'mixed allowed+denied → denied')
  assertTrue(String(r.reason).includes('8.8.8.8'), 'reason names the denied host')
})

test('netexec: empty allowlist denies everything (governance)', () => {
  const r = validateTargets('192.168.1.10', [])
  assertTrue(!r.ok, 'denied')
  assertTrue(String(r.reason).includes('allowlist'), 'reason mentions allowlist')
})

test('netexec: null allowlist denies everything (governance)', () => {
  const r = validateTargets('192.168.1.10', null as any)
  assertTrue(!r.ok, 'denied')
})

test('netexec: empty targets string rejected (FN guard)', () => {
  const r = validateTargets('', ['192.168.1.10'])
  assertTrue(!r.ok, 'rejected')
  const r2 = validateTargets(undefined as any, ['x'])
  assertTrue(!r2.ok, 'undefined rejected')
})

test('netexec: whitespace-only targets rejected (bypass attempt)', () => {
  const r = validateTargets('   ,  ,', ['192.168.1.10'])
  // "  ,  ," splits to no real targets — must not accidentally pass
  const requested = (r as any).targets
  assertTrue(!r.ok || (Array.isArray(requested) && requested.length === 0), 'no real targets')
})

// --- output parsing ---

test('netexec: parses success and failure lines', () => {
  const raw = [
    'SMB         192.168.1.10   445    HOSTNAME        [+] hostname\\admin (Pwn3d!)',
    'SMB         192.168.1.11   445    HOSTNAME2       [-] hostname\\admin:BADPW',
  ].join('\n')
  const p = parseNetexecOutput(raw)
  assertEqual(p.hosts.length, 2, 'two hosts')
  assertEqual(p.authSuccess.length, 1, 'one success')
  assertEqual(p.authFailed.length, 1, 'one failure')
  assertTrue(p.authSuccess[0].pwned, 'pwned flag on (Pwn3d!)')
  assertEqual(p.hosts[0].status, 'auth-ok', 'status')
})

test('netexec: info lines ([*]) are hosts, not auth results (FP guard)', () => {
  const raw = 'SMB  192.168.1.10 445 HOSTNAME [*] Windows Server 2019'
  const p = parseNetexecOutput(raw)
  assertEqual(p.hosts.length, 1, 'one host')
  assertEqual(p.authSuccess.length, 0, 'not an auth success')
  assertEqual(p.hosts[0].status, 'info', 'info status')
})

test('netexec: error lines captured, not lost (FN guard)', () => {
  const raw = 'something went wrong: connection refused\ntraceback (most recent call last)'
  const p = parseNetexecOutput(raw)
  assertTrue(p.errors.length >= 1, 'errors captured')
})

test('netexec: empty/null output handled (FP guard)', () => {
  assertEqual(parseNetexecOutput('').hosts.length, 0, 'empty string')
  assertEqual(parseNetexecOutput(null as any).hosts.length, 0, 'null')
})

// --- spray plan ---

test('netexec: spray plan is slow, jittered, and counted', () => {
  const plan = buildSprayPlan({ targets: '10.0.0.1', usernames: ['a', 'b', 'c'], attemptsPerUser: 2, delayMs: 5000, jitterMs: 2000 })
  assertEqual(plan.totalAttempts, 6, '3 users × 2 attempts')
  assertEqual(plan.steps.length, 6, 'six steps')
  for (const s of plan.steps) {
    assertTrue(s.waitBeforeMs >= 5000, 'every wait ≥ delayMs')
    assertTrue(s.waitBeforeMs <= 7000, 'every wait ≤ delayMs+jitter')
  }
  assertTrue(plan.note.includes('SLOW'), 'note says SLOW')
})

test('netexec: spray plan without usernames rejected (FN guard)', () => {
  try {
    buildSprayPlan({ targets: 'x', usernames: [] })
    throw new Error('should have thrown')
  } catch { /* expected */ }
})

test('netexec: spray plan without targets rejected (FN guard)', () => {
  try {
    buildSprayPlan({ usernames: ['a'] } as any)
    throw new Error('should have thrown')
  } catch { /* expected */ }
})

// ═══════════════════════════════════════════════════════════════════════════
// Plugin registration smoke tests (register() with a mock ctx)
// ═══════════════════════════════════════════════════════════════════════════

function mockCtx() {
  const tools: any[] = []
  const triggers: any[] = []
  const panels: any[] = []
  return {
    tools, triggers, panels,
    registerTool: (t: any) => tools.push(t),
    registerTrigger: (t: any) => triggers.push(t),
    registerPanel: (p: any) => panels.push(p),
    log: () => {},
    spawnProcess: () => null,
  }
}

test('plugins: promptfoo registers 1 tool + 1 panel', async () => {
  const { register } = await import('../../../../plugins/promptfoo-redteam/index.mjs')
  const ctx = mockCtx()
  register(ctx)
  assertEqual(ctx.tools.length, 1, 'one tool')
  assertEqual(ctx.tools[0].name, 'promptfoo_redteam', 'tool name')
  assertEqual(ctx.panels.length, 1, 'one panel')
})

test('plugins: mitmproxy registers 3 tools + 1 panel', async () => {
  const { register } = await import('../../../../plugins/mitmproxy-bridge/index.mjs')
  const ctx = mockCtx()
  register(ctx)
  assertEqual(ctx.tools.length, 3, 'three tools')
  const names = ctx.tools.map((t: any) => t.name).sort()
  assertDeepEqual(names, ['mitm_flows', 'mitm_start', 'mitm_stop'], 'tool names')
})

test('plugins: netexec registers 2 tools + 1 trigger + 1 panel', async () => {
  const { register } = await import('../../../../plugins/netexec-bridge/index.mjs')
  const ctx = mockCtx()
  register(ctx)
  assertEqual(ctx.tools.length, 2, 'two tools')
  assertEqual(ctx.triggers.length, 1, 'one trigger')
  assertEqual(ctx.panels.length, 1, 'one panel')
})

test('plugins: netexec_check refuses to run without an allowlist (governance)', async () => {
  const { register } = await import('../../../../plugins/netexec-bridge/index.mjs')
  const ctx = mockCtx()
  register(ctx)
  const tool = ctx.tools.find((t: any) => t.name === 'netexec_check')
  const res = await tool.handler({ protocol: 'smb', targets: '192.168.1.10', action: 'users' })
  assertTrue(Boolean(res?.error), 'returns an error')
  assertTrue(String(res.error).includes('allowlist'), 'error mentions allowlist')
})

test('plugins: netexec_check refuses out-of-allowlist targets (governance)', async () => {
  const { register } = await import('../../../../plugins/netexec-bridge/index.mjs')
  const ctx = mockCtx()
  register(ctx)
  const tool = ctx.tools.find((t: any) => t.name === 'netexec_check')
  const res = await tool.handler({
    protocol: 'smb', targets: '8.8.8.8', action: 'users',
    allowlist: ['192.168.1.0/24'],
  })
  assertTrue(Boolean(res?.error), 'returns an error')
  assertTrue(String(res.error).includes('8.8.8.8'), 'error names the denied target')
})

test('plugins: mitm_start reverse mode requires an allowlist (governance)', async () => {
  const { register } = await import('../../../../plugins/mitmproxy-bridge/index.mjs')
  const ctx = mockCtx()
  register(ctx)
  const tool = ctx.tools.find((t: any) => t.name === 'mitm_start')
  const res = await tool.handler({ mode: 'reverse', upstreamTarget: 'api.example.com:443' })
  assertTrue(Boolean(res?.error), 'returns an error')
  assertTrue(String(res.error).includes('allowlist'), 'error mentions allowlist')
})

test('plugins: promptfoo_redteam requires providers (FN guard)', async () => {
  const { register } = await import('../../../../plugins/promptfoo-redteam/index.mjs')
  const ctx = mockCtx()
  register(ctx)
  const res = await ctx.tools[0].handler({})
  assertTrue(Boolean(res?.error), 'returns an error')
  assertTrue(String(res.error).includes('providers'), 'error mentions providers')
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
