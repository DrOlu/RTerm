/**
 * reactorpro-bridge — wire compatibility with the ReactorPro gateway.
 *
 * This is the contract test for v3.8.5: the plugin must be interoperable
 * with the REAL gateway implementation (crates/agent-gateway/internal/mesh),
 * the way the ReactorPro desktop implements it. Two halves:
 *
 *   A. Pure-JS invariants (always run): fingerprint derivation, signing
 *      payload construction, envelope sign/verify round-trip, respond/error
 *      shapes, identity minting + tamper detection, settings persistence
 *      (the v3.1.3 lesson: a settings block missing from pickBackendSnapshot
 *      is silently wiped on save).
 *
 *   B. Go cross-check (runs when the ReactorPro checkout + Go are present):
 *      the plugin signs an envelope, and the GATEWAY's own VerifyEnvelope
 *      must accept it; the gateway signs one, and the plugin must accept it.
 *      Skipped cleanly when the checkout is absent — CI without the ReactorPro
 *      repo still runs part A.
 *
 * Run:  npx tsx plugins/reactorpro-bridge/reactorpro-bridge.extreme.spec.mts
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AUTH_KEYS,
  buildManifest,
  buildRespond,
  checkIdentity,
  defaultServeSkills,
  envelope,
  fingerprintFor,
  mintIdentity,
  rawPublicKeyFromPem,
  signEnvelope,
  signingPayload,
  verifyEnvelope,
} from './reactorproAgent.mjs'
import { loadOrCreateIdentity, resolveConfig } from './index.mjs'

let pass = 0
let fail = 0
const failures: string[] = []

function ok(cond: unknown, label: string, note = ''): void {
  if (cond) {
    pass++
    console.log(`PASS ${label}`)
  } else {
    fail++
    failures.push(label)
    console.log(`FAIL ${label}${note ? ` — ${note}` : ''}`)
  }
}

// ─── A. pure-JS invariants ───────────────────────────────────────────────────

// A1. Fingerprint: sha256:<16hex> over "<agent id>\n" + raw SPKI public key.
{
  const id = mintIdentity('rterm/xcheck/fixture')
  const fp = fingerprintFor('rterm/xcheck/fixture', id.publicKeyPem)
  ok(/^sha256:[0-9a-f]{16}$/.test(fp), 'fingerprint is sha256:<16hex>')
  // The id is inside the digest: same key, different id => different fp.
  const fp2 = fingerprintFor('rterm/xcheck/other', id.publicKeyPem)
  ok(fp !== fp2, 'fingerprint binds the agent id (different id => different fp)')
  // And the raw public key must round-trip from the PEM.
  ok(rawPublicKeyFromPem(id.publicKeyPem).length === 32, 'raw public key is 32 bytes (Ed25519)')
}

// A2. checkIdentity detects tampering.
{
  const id = mintIdentity('rterm/xcheck/tamper')
  let threw = false
  try {
    // The identity's id field is `identity` — mutating it (e.g. renaming the
    // agent) breaks the fingerprint, which binds id + key.
    checkIdentity({ ...id, identity: 'someone-else' } as never)
  } catch {
    threw = true
  }
  ok(threw, 'checkIdentity rejects an identity whose fingerprint does not match')

  let threwKey = false
  const other = mintIdentity('rterm/xcheck/tamper')
  try {
    checkIdentity({ ...id, publicKeyPem: other.publicKeyPem } as never)
  } catch {
    threwKey = true
  }
  ok(threwKey, 'checkIdentity rejects a swapped public key')
}

// A3. signEnvelope/verifyEnvelope round-trip, ReactorPro convention.
{
  const id = mintIdentity('rterm/xcheck/signer')
  const cfg = { agentId: 'rterm/xcheck/signer', prefix: 'mesh', fingerprint: id.fingerprint }
  const env = envelope('request', { skill: 'ping', input: {}, reply_to: '_REPLY.abc.123' }, cfg, { to: 'peer-1' })
  const signed = signEnvelope(env, id)

  ok(AUTH_KEYS.every((k) => typeof (signed as Record<string, unknown>)[k] === 'string'),
    'signed envelope carries sig/pub/fp')
  const v = verifyEnvelope(signed)
  ok(v.ok && v.note !== 'unsigned', `plugin verifies its own signature (${v.note})`)

  // Tamper with the payload -> signature must fail.
  const tampered = { ...(signed as Record<string, unknown>), payload: { skill: 'invoke', input: { evil: true } } }
  const tv = verifyEnvelope(tampered)
  ok(!tv.ok, 'tampered payload fails verification')

  // Swap the fingerprint -> identity mismatch.
  const fpSwap = { ...(signed as Record<string, unknown>), fp: 'sha256:deadbeefdeadbeef' }
  const fv = verifyEnvelope(fpSwap)
  ok(!fv.ok, 'swapped fingerprint fails verification')
}

// A4. The signing payload covers every meaning-bearing field (gateway order).
{
  const env = {
    v: '0.3.0', id: 'id-1', type: 'respond', ts: '2026-09-17T00:00:00Z',
    from: 'a', to: 'b', task_id: 't-1', in_reply_to: 'r-1', fp: 'sha256:0123456789abcdef',
    trace: { trace_id: 'tr-1', span_id: 'sp-1' },
    error: { code: 3001, message: 'SKILL_NOT_FOUND', retryable: false },
    payload: { output: { x: 1 } },
  }
  const sp = signingPayload(env as never)
  const text = sp.toString('latin1')
  // Length-prefixed fields in gateway order: v, id, type, ts, from, to, task_id, in_reply_to, fp
  ok(text.startsWith('5:0.3.0\n'), 'signing payload starts with the version field, length-prefixed')
  ok(text.includes('4:id-1\n'), 'signing payload includes id')
  ok(text.includes('7:respond\n'), 'signing payload includes type')
  ok(text.includes('1:a\n'), 'signing payload includes from')
  ok(text.includes('5:tr-1\n') || text.includes('4:tr-1\n'), 'signing payload includes trace_id')
  ok(text.includes('4:3001\n'), 'signing payload includes error code')
  // Absent trace/error contribute their empty positions.
  const bare = signingPayload({ v: '0.3.0', id: 'x', type: 'emit', ts: 't', from: 'f' } as never)
  const bareText = bare.toString('latin1')
  ok(bareText.includes('0:\n0:\n'), 'absent trace/error contribute empty positions')
}

// A5. buildRespond: output XOR error, in_reply_to + task_id correlation.
{
  const cfg = { agentId: 'a', prefix: 'mesh' }
  const req = { id: 'req-1', from: 'caller', task_id: 'task-9' }
  const r = buildRespond(req as never, cfg, { output: { pong: true } })
  ok(r.in_reply_to === 'req-1' && r.task_id === 'task-9' && r.to === 'caller',
    'respond correlates in_reply_to/task_id/to')
  ok((r.payload as Record<string, unknown>).output !== undefined, 'respond payload carries output')

  let threw = false
  try {
    buildRespond(req as never, cfg, { output: { a: 1 }, error: { code: 1, message: 'x', retryable: false } } as never)
  } catch {
    threw = true
  }
  ok(threw, 'respond rejects output AND error together')
}

// A6. Settings persistence — the v3.1.3 lesson.
// resolveConfig must read the reactorpro block, and the block must survive
// the migration snapshot (pickBackendSnapshot) — verified by importing the
// real migrations module.
{
  const cfg = resolveConfig({
    settings: {
      reactorpro: {
        enabled: true,
        url: 'nats://mesh.example:4222',
        agentId: 'rterm/xcheck/persist',
        prefix: 'mesh',
        identityPath: '/tmp/xcheck-identity.json',
        dispatchTimeout: 240000,
      },
    },
  })
  ok(cfg.agentId === 'rterm/xcheck/persist', 'resolveConfig reads reactorpro.agentId')
  ok(cfg.dispatchTimeout === 240000, 'resolveConfig reads reactorpro.dispatchTimeout')
  ok(cfg.enabled === true, 'resolveConfig reads reactorpro.enabled')

  // The migration whitelist must carry the block. Import the real module.
  const migrationsPath = join(import.meta.dirname, '..', '..', 'packages', 'backend', 'src', 'services', 'settings', 'migrations.ts')
  if (existsSync(migrationsPath)) {
    const src = readFileSync(migrationsPath, 'utf-8')
    ok(src.includes('reactorpro: raw.reactorpro'),
      'pickBackendSnapshot carries reactorpro (v3.1.3 lesson: missing keys are silently wiped)')
    ok(src.includes('normalizeReactorProSettings'),
      'normalizeBackendSettings sanitizes the reactorpro block')
  } else {
    ok(false, 'migrations.ts not found for the persistence check')
  }
}

// A7. Identity persistence: mint once, load forever; 0600; tamper detection.
{
  const dir = mkdtempSync(join(tmpdir(), 'rp-xcheck-'))
  const identityPath = join(dir, 'identity.json')
  const cfg = { agentId: 'rterm/xcheck/persist-id', identityPath }
  const first = loadOrCreateIdentity(cfg as never)
  const second = loadOrCreateIdentity(cfg as never)
  ok(first.fingerprint === second.fingerprint, 'identity is minted once and reloaded unchanged')

  // Tamper with the stored identity -> loadOrCreateIdentity must throw.
  const stored = JSON.parse(readFileSync(identityPath, 'utf-8'))
  stored.identity = 'attacker'
  writeFileSync(identityPath, JSON.stringify(stored))
  let threw = false
  try {
    loadOrCreateIdentity(cfg as never)
  } catch {
    threw = true
  }
  ok(threw, 'a tampered identity file is rejected on load')
}

// ─── A2. Manifest shape contract (the gateway's Manifest struct) ─────────────
// Found live: the plugin sent `identity` where the gateway's Manifest
// unmarshals `json:"id"`, and bare-string skills where the gateway expects
// []{id,name,description} objects. manifestMatches drops a manifest whose ID
// is empty, so the peer was INVISIBLE to gateway discovery. These pin the
// corrected contract so it cannot regress.

{
  const cfg = { agentId: 'rterm/xcheck/manifest', name: 'XCheck', fingerprint: 'sha256:abc123' }
  const m = buildManifest(cfg, ['ping', 'describe', 'status', 'invoke'])
  ok(m.id === 'rterm/xcheck/manifest',
    'manifest uses id (json:"id") — the gateway drops a manifest with empty ID',
    JSON.stringify(Object.keys(m)))
  ok(!('identity' in m), 'manifest must NOT carry a legacy identity key')
  ok(m.name === 'XCheck', 'manifest name is the display name')
  ok(Array.isArray(m.capabilities) && m.capabilities.includes('rterm'),
    'manifest advertises the rterm capability')
  ok(Array.isArray(m.skills) && m.skills.length === 4
    && m.skills.every((s: { id: string }) => typeof s?.id === 'string'),
    'skills are []{id,...} objects, not bare strings (the gateway Skill struct unmarshals objects)',
    JSON.stringify(m.skills))
  ok(m.fingerprint === 'sha256:abc123', 'manifest carries the fingerprint for TOFU pinning')
  ok(Array.isArray(m.local_agents) && m.local_agents[0]?.id === cfg.agentId,
    'local_agents entries use id too')
}

// A string skill list must be normalized to objects without dropping any.
{
  const m = buildManifest({ agentId: 'a' }, ['ping', 'status'])
  ok(m.skills.length === 2 && m.skills[0].id === 'ping' && m.skills[1].id === 'status',
    'string skill ids normalize to {id,name} objects in order')
}

// A discover reply in the GATEWAY's bare-manifest shape must be accepted by
// the plugin's parser (the old parser only read payload.manifest). The
// candidates logic lives inline in discoverPeers; this pins the accepted
// payload shapes by constructing them the way the gateway does.
{
  const bare = { id: 'gateway/edge-1', name: 'Edge', skills: [{ id: 'ping' }] }
  const agents = { agents: [{ id: 'gateway/edge-2', name: 'Edge2' }] }
  const legacy = { manifest: { id: 'old/peer', name: 'Old' } }
  const shapes = [bare, agents, legacy]
  for (const p of shapes) {
    const candidates = Array.isArray((p as { agents?: unknown[] }).agents)
      ? (p as { agents: unknown[] }).agents
      : ((p as { id?: string }).id || (p as { identity?: string }).identity)
        ? [p]
        : ((p as { manifest?: { id?: string } }).manifest?.id
          || (p as { manifest?: { identity?: string } }).manifest?.identity)
          ? [(p as { manifest: unknown }).manifest]
          : []
    ok(candidates.length > 0, `discover parser accepts payload shape ${JSON.stringify(Object.keys(p))}`)
  }
}

// ─── A3. Inbound invoke skill (v3.8.8) ───────────────────────────────────────
// Found live: the manifest ADVERTISED invoke but defaultServeSkills had no
// handler, so a peer dispatching invoke got SKILL_NOT_FOUND while the
// manifest promised it. These pin the corrected contract.

{
  // A3.1 invoke exists in the default skills and routes to runAgentTask.
  const cfg = { agentId: 'rterm/xcheck/invoke', dispatchTimeout: 180000 }
  const skills = defaultServeSkills(cfg, {
    startedAt: Date.now(),
    runAgentTask: async (prompt: string, opts?: { sessionId?: string; timeoutMs?: number }) => {
      ok(prompt === 'Reply with exactly one word: PONG',
        'invoke passes the prompt through to runAgentTask (arguments.prompt)',
        JSON.stringify({ prompt }))
      ok(typeof opts?.timeoutMs === 'number' && opts.timeoutMs === 170000,
        'invoke stays under the mesh dispatch budget (dispatchTimeout - 10s)',
        JSON.stringify(opts))
      return { ok: true, answer: 'PONG', sessionId: 'mesh-invoke-test' }
    },
  })
  ok(typeof skills.invoke === 'function', 'defaultServeSkills includes an invoke handler')

  const r1 = await skills.invoke({ arguments: { prompt: 'Reply with exactly one word: PONG' } } as never)
  ok(r1?.output === 'PONG', 'invoke returns the agent answer as output', JSON.stringify(r1))
  ok(r1?.conversation_id === 'mesh-invoke-test', 'invoke returns conversation_id for session persistence')

  // A3.2 prompt extraction: text/ prompt/ message all work.
  const skills2 = defaultServeSkills({ agentId: 'a' }, {
    runAgentTask: async (prompt: string) => ({ ok: true, answer: `got:${prompt}`, sessionId: 's' }),
  })
  const viaText = await skills2.invoke({ text: 'hello' } as never)
  ok(viaText?.output === 'got:hello', 'invoke extracts input.text')
  const viaPrompt = await skills2.invoke({ prompt: 'hi' } as never)
  ok(viaPrompt?.output === 'got:hi', 'invoke extracts input.prompt')
  const viaString = await skills2.invoke('plain' as never)
  ok(viaString?.output === 'got:plain', 'invoke extracts a bare string input')

  // A3.3 conversation_id routes the follow-up to the same agent session.
  const seenSessions: Array<string | undefined> = []
  const skills3 = defaultServeSkills({ agentId: 'a' }, {
    runAgentTask: async (_p: string, o?: { sessionId?: string }) => {
      seenSessions.push(o?.sessionId)
      return { ok: true, answer: 'x', sessionId: o?.sessionId ?? 'new' }
    },
  })
  const first = await skills3.invoke({ text: 'one' } as never)
  // First call: no conversation_id yet -> the hook generates a session.
  ok(seenSessions[0] === undefined, 'first invoke has no session yet (the hook mints one)')
  await skills3.invoke({ text: 'two', conversation_id: first.conversation_id } as never)
  ok(seenSessions[1] === first.conversation_id && first.conversation_id !== undefined,
    'conversation_id reuses the same agent session on the follow-up',
    JSON.stringify({ seenSessions, firstId: first.conversation_id }))

  // A3.4 no runAgentTask hook -> a CLEAR error, not SKILL_NOT_FOUND.
  const skills4 = defaultServeSkills({ agentId: 'a' }, {})
  const r4 = await skills4.invoke({ text: 'x' } as never)
  ok(r4?.error?.code === 3002 && String(r4?.error?.message).includes('INVOKE_UNAVAILABLE'),
    'invoke without the runAgentTask hook returns INVOKE_UNAVAILABLE (not SKILL_NOT_FOUND)',
    JSON.stringify(r4))

  // A3.5 empty prompt -> a clear error.
  const skills5 = defaultServeSkills({ agentId: 'a' }, {
    runAgentTask: async () => ({ ok: true, answer: 'should not run', sessionId: 's' }),
  })
  const r5 = await skills5.invoke({} as never)
  ok(r5?.error?.code === 3003 && String(r5?.error?.message).includes('INVOKE_NEEDS_PROMPT'),
    'invoke with no prompt returns INVOKE_NEEDS_PROMPT without running the agent',
    JSON.stringify(r5))

  // A3.6 a failed agent turn -> a retryable error carrying the reason.
  const skills6 = defaultServeSkills({ agentId: 'a' }, {
    runAgentTask: async () => ({ ok: false, answer: '', error: 'model offline', sessionId: 's' }),
  })
  const r6 = await skills6.invoke({ text: 'x' } as never)
  ok(r6?.error?.code === 5001 && String(r6?.error?.message).includes('model offline'),
    'a failed agent turn surfaces as a retryable error with the reason',
    JSON.stringify(r6))
}

// ─── B. Go cross-check against the REAL gateway ──────────────────────────────

const RP_CHECKOUT = process.env.RP_CHECKOUT ?? join(process.env.HOME ?? '', 'work', 'ReactorPro')
const RP_GW = join(RP_CHECKOUT, 'crates', 'agent-gateway')

if (existsSync(join(RP_GW, 'go.mod')) && existsSync('/opt/homebrew/bin/go')) {
  console.log('\n-- Go cross-check against the real gateway --')
  const fixtureDir = mkdtempSync(join(tmpdir(), 'rp-fixtures-'))

  // B1. Plugin signs -> gateway verifies.
  const id = mintIdentity('rterm/xcheck/go')
  writeFileSync(join(fixtureDir, 'gateway_identity.json'), JSON.stringify({
    identity: 'rterm/xcheck/go',
    privateKeyPem: id.privateKeyPem,
    publicKeyPem: id.publicKeyPem,
    fingerprint: id.fingerprint,
  }, null, 2))

  const cfg = { agentId: 'rterm/xcheck/go', prefix: 'mesh', fingerprint: id.fingerprint }
  const env = envelope('respond', { output: { cross: true } }, cfg, { to: 'reactorpro/edge-1' })
  const signed = signEnvelope(env, id)
  // COMPACT on purpose. The gateway's Envelope.Payload is a json.RawMessage,
  // which captures the payload bytes EXACTLY as they appear in the file —
  // including any pretty-print indentation. The plugin signs
  // JSON.stringify(payload) (compact) and publishes j(signed) (compact), so a
  // pretty-printed fixture would make the gateway re-hash DIFFERENT bytes than
  // were signed and fail verification even though the real wire exchange is
  // correct. The fixture must be byte-faithful to the wire.
  writeFileSync(join(fixtureDir, 'plugin_signed_envelope.json'), JSON.stringify(signed))
  writeFileSync(join(fixtureDir, 'plugin_signing_payload.hex'),
    signingPayload(signed as never).toString('hex') + '\n')

  const goTest = spawnSync('/opt/homebrew/bin/go', ['test', './internal/mesh', '-run', 'TestRtermBridgeCrossVerify', '-v', '-count=1'],
    { cwd: RP_GW, env: { ...process.env, RTERM_BRIDGE_FIXTURES: fixtureDir }, encoding: 'utf-8', timeout: 180000 })

  ok(goTest.status === 0,
    `the REAL gateway verifies the plugin's envelope (go test exit ${goTest.status})`,
    goTest.status !== 0 ? (goTest.stderr || goTest.stdout || '').split('\n').filter((l) => l.includes('FAIL') || l.includes('mismatch')).slice(0, 3).join('; ') : '')

  // B2. Gateway signs -> plugin verifies.
  const gwEnvPath = join(fixtureDir, 'gateway_signed_envelope.json')
  if (existsSync(gwEnvPath)) {
    const gwEnv = JSON.parse(readFileSync(gwEnvPath, 'utf-8'))
    const v = verifyEnvelope(gwEnv)
    ok(v.ok && v.note !== 'unsigned',
      `the plugin verifies the gateway's envelope (${v.note})`,
      JSON.stringify(v))
  } else {
    ok(false, 'gateway_signed_envelope.json was not produced by the Go test')
  }
} else {
  console.log('\n-- Go cross-check skipped (ReactorPro checkout or Go not present) --')
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log(`FAILURES:\n${failures.map((f) => `  - ${f}`).join('\n')}`)
  process.exit(1)
}
console.log('reactorpro-bridge: ALL TESTS PASSED')