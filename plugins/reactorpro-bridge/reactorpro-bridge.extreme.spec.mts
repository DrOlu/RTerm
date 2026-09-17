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
  buildRespond,
  checkIdentity,
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