/**
 * reactorproAgent — full-duplex ReactorPro mesh citizen for RTerm/neuralOS.
 *
 * Implements the ReactorPro gateway wire protocol exactly as the gateway
 * enforces it (crates/agent-gateway/internal/mesh/):
 *
 *   1. IDENTITY — Ed25519 keypair bound to an agent id; fingerprint
 *      sha256:<16hex> over `<agent id>\n` + raw public key bytes. The id is
 *      inside the digest, so a key under another id is a different identity.
 *   2. ENVELOPE — v0.3.0 signed JSON with `sig`/`pub`/`fp` (the ReactorPro
 *      convention; the legacy Synapse `signature`/`from_identity` fields are
 *      ignored by ReactorPro edges and cannot invoke).
 *   3. RESPONDER — serve `mesh.agent.<id>.inbox` (core NATS, NEVER JetStream
 *      — a stream over the inbox breaks request/reply), answering skills.
 *   4. HEARTBEAT — signed liveness on `mesh.heartbeat.<id>`; registry entries
 *      expire (TTL ≈ 3× heartbeat), so a dead edge stops being advertised.
 *   5. REGISTRY — announce the manifest on `mesh.registry.register` (KV bucket
 *      `mesh_registry`) and answer `mesh.registry.discover` broadcasts.
 *
 * Pure functions (signing, fingerprint, envelope) are dependency-free and
 * unit-testable; transport is injected.
 */

import { randomUUID, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify } from 'node:crypto'

const enc = new TextEncoder()
const dec = new TextDecoder()
const j = (v) => enc.encode(JSON.stringify(v))
const uj = (b) => JSON.parse(dec.decode(b))

// ─── 1. IDENTITY ────────────────────────────────────────────────────────────

/** Raw 32-byte Ed25519 public key from a PEM SPKI certificate.
 *
 * The gateway's FingerprintFor hashes the RAW key bytes
 * (identity.go: `sha256(agentID + "\n" + publicKey)` where publicKey is
 * ed25519.PublicKey), and VerifyEnvelope calls ed25519.Verify with that raw
 * key. The PEM body is the 44-byte SPKI DER — a 12-byte ASN.1 header
 * (302a300506032b6570032100) followed by the 32-byte key — so the header must
 * be stripped. Base64-decoding the PEM body alone returns all 44 bytes. */
export function rawPublicKeyFromPem(pem) {
  const keyObject = createPublicKey(pem)
  const spki = keyObject.export({ type: 'spki', format: 'der' })
  if (spki.length < 32) {
    throw new Error(`SPKI DER too short for Ed25519: ${spki.length} bytes`)
  }
  return Buffer.from(spki.subarray(spki.length - 32))
}

/**
 * fingerprint = "sha256:" + hex(sha256(agent_id + "\n" + raw_pubkey))[:16]
 * The id is inside the digest — same key under another id = different fp.
 */
export function fingerprintFor(agentId, publicKeyPem) {
  const raw = rawPublicKeyFromPem(publicKeyPem)
  const digest = Buffer.concat([enc.encode(agentId + '\n'), raw])
  const hex = createHash('sha256').update(digest).digest('hex')
  return 'sha256:' + hex.slice(0, 16)
}

/** Mint a new gateway-compatible identity: {identity, privateKeyPem,
 *  publicKeyPem, fingerprint}. The id is permanent — it is bound into the
 *  fingerprint; minting again under the same id is a DIFFERENT identity. */
export function mintIdentity(agentId) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  return {
    identity: agentId,
    privateKeyPem,
    publicKeyPem,
    fingerprint: fingerprintFor(agentId, publicKeyPem),
  }
}

/** Verify an identity file's internal consistency (id ↔ key ↔ fingerprint). */
export function checkIdentity(id) {
  const fp = fingerprintFor(id.identity, id.publicKeyPem)
  if (id.fingerprint !== fp) {
    throw new Error('identity fails its own fingerprint check — tampered or wrong format')
  }
  return id
}

// ─── 2. ENVELOPE + SIGNING (ReactorPro convention) ──────────────────────────

export const AUTH_KEYS = ['sig', 'pub', 'fp']

/** The exact byte string an Ed25519 signature covers — a field-joined,
 *  length-prefixed digest, mirrored from the gateway's SigningPayload
 *  (internal/mesh/identity.go). Lengths are UTF-8 byte lengths.
 *
 *  Fields: v, id, type, ts, from, to, task_id, in_reply_to, fp,
 *  [trace_id, span_id], [err_code, err_message, err_retryable],
 *  then the raw sha256(payload) digest. Optional groups contribute their
 *  empty positions when absent, so "absent" and "empty" cannot collide. */
export function signingPayload(env) {
  const parts = [
    env.v ?? '', env.id ?? '', env.type ?? '',
    env.ts ?? '', env.from ?? '', env.to ?? '',
    env.task_id ?? '', env.in_reply_to ?? '', env.fp ?? '',
  ]
  const trace = env.trace
  if (trace && typeof trace === 'object') {
    parts.push(trace.trace_id ?? '', trace.span_id ?? '')
  } else {
    parts.push('', '')
  }
  const error = env.error
  if (error && typeof error === 'object') {
    parts.push(String(error.code ?? 0), String(error.message ?? ''), error.retryable ? 'true' : 'false')
  } else {
    parts.push('', '', '')
  }

  const chunks = []
  for (const part of parts) {
    const raw = enc.encode(String(part))
    chunks.push(enc.encode(`${Buffer.byteLength(raw)}:`), raw, enc.encode('\n'))
  }
  const payload = env.payload
  const payloadBytes = payload === undefined || payload === null
    ? Buffer.alloc(0)
    : Buffer.from(JSON.stringify(payload), 'utf-8')
  chunks.push(createHash('sha256').update(payloadBytes).digest())
  return Buffer.concat(chunks)
}

/** Build an unsigned envelope (register|discover|request|respond|emit|heartbeat). */
export function envelope(type, payload, cfg, extra = {}) {
  return {
    v: '0.3.0',
    id: randomUUID(),
    type,
    ts: new Date().toISOString(),
    from: cfg.agentId,
    ...(cfg.fingerprint ? { fp: cfg.fingerprint } : {}),
    trace: { trace_id: randomUUID(), span_id: randomUUID() },
    payload,
    ...extra,
  }
}

/** Attach pub/fp/sig the ReactorPro way. The signature covers the fingerprint
 *  but not the public key or itself, matching the gateway. */
export function signEnvelope(env, identity) {
  const signed = {}
  for (const [k, v] of Object.entries(env)) {
    if (!AUTH_KEYS.includes(k)) signed[k] = v
  }
  signed.pub = identity.publicKeyPem
  signed.fp = identity.fingerprint
  const priv = createPrivateKey(identity.privateKeyPem)
  signed.sig = edSign(null, signingPayload(signed), priv).toString('hex')
  return signed
}

/** Verify a ReactorPro-convention signature. { ok: true, note: 'unsigned' }
 *  when the envelope carries none — that is a policy decision, not a
 *  verification failure.
 *
 *  Only sig and pub are stripped before recomputing the payload — the
 *  fingerprint is deliberately RETAINED because the gateway's SigningPayload
 *  covers it (identity.go: "Fingerprint is deliberately retained: it is part
 *  of the signed payload"). Stripping fp here made the verifier's payload
 *  differ from the signer's, so every signature failed. */
export function verifyEnvelope(env) {
  const pubPem = env?.pub ?? ''
  const sigHex = env?.sig ?? ''
  if (!pubPem || !sigHex) return { ok: true, note: 'unsigned' }
  try {
    const unsigned = {}
    for (const [k, v] of Object.entries(env)) {
      if (k === 'sig' || k === 'pub') continue
      unsigned[k] = v
    }
    // Node's edVerify needs a KeyObject — a raw 32-byte buffer throws
    // ERR_OSSL_UNSUPPORTED. The PEM round-trips through createPublicKey.
    const pub = createPublicKey(pubPem)
    const ok = edVerify(null, signingPayload(unsigned), pub, Buffer.from(sigHex, 'hex'))
    if (!ok) return { ok: false, note: 'signature check failed' }
  } catch (e) {
    return { ok: false, note: `signature check failed: ${e?.message ?? e}` }
  }
  const claimed = env?.fp ?? ''
  const proved = fingerprintFor(String(env?.from ?? ''), pubPem)
  if (claimed && claimed !== proved) {
    return { ok: false, note: `fingerprint mismatch: claims ${claimed}, key proves ${proved}` }
  }
  return { ok: true, note: proved }
}

/** A JetStream PubAck ({"stream":…,"seq":…}) rather than a mesh envelope. */
export function isPublishAck(data) {
  try {
    const o = uj(data)
    return typeof o === 'object' && o !== null && 'stream' in o && 'seq' in o && !('type' in o) && !('id' in o)
  } catch { return false }
}

// ─── 3. RESPONDER (inbox serving, core NATS only) ───────────────────────────

/** Build a ReactorPro respond envelope (payload has output XOR error). */
export function buildRespond(requestEnv, cfg, { output, error } = {}) {
  if (output && error) throw new Error('respond must contain output OR error, not both')
  const payload = error ? { error } : { output: output ?? {} }
  return envelope('respond', payload, cfg, {
    to: requestEnv?.from,
    task_id: requestEnv?.task_id,
    in_reply_to: requestEnv?.id,
  })
}

/** Skills RTerm serves on the mesh by default. The `invoke` skill routes a
 *  prompt into a real RTerm agent turn (the same path the desktop uses). */
export function defaultServeSkills(cfg, deps = {}) {
  return {
    ping: async () => ({ pong: true, ts: new Date().toISOString() }),
    describe: async () => buildManifest(cfg, deps.skills ? Object.keys(deps.skills) : ['ping', 'describe', 'status', 'invoke']),
    status: async () => ({
      agent_id: cfg.agentId,
      fingerprint: cfg.fingerprint ?? null,
      connected: true,
      skills: ['ping', 'describe', 'status', 'invoke'],
      uptime_seconds: Math.floor((Date.now() - (deps.startedAt ?? Date.now())) / 1000),
    }),
    ...(deps.skills ?? {}),
  }
}

/** Start the responder loop: subscribe to mesh.agent.<id>.inbox (core NATS),
 *  execute each request's skill, and respond on the reply subject. Returns a
 *  stop function. Never JetStream over the inbox — see §inbox-streaming. */
export async function startResponder(nc, cfg, ctx, log = () => {}) {
  const inbox = `${cfg.prefix}.agent.${cfg.agentId}.inbox`
  const sub = nc.subscribe(inbox)
  let stopped = false
  const loop = (async () => {
    for await (const msg of sub) {
      if (stopped) break
      ;(async () => {
        try {
          if (isPublishAck(msg.data)) return // skip ack-shaped messages
          const req = uj(msg.data)
          const skillId = req?.payload?.skill
          const input = req?.payload?.input
          log(`[reactorpro] inbound request from ${req?.from} skill=${skillId} task=${req?.task_id}`)
          const result = await executeSkill(skillId, input, ctx)
          const respond = buildRespond(req, cfg, result)
          const signed = ctx.identity ? signEnvelope(respond, ctx.identity) : respond
          const replySubject = req?.payload?.reply_to || msg.reply
          if (replySubject && typeof nc.publish === 'function') nc.publish(replySubject, j(signed))
          else if (typeof msg.respond === 'function') msg.respond(j(signed))
        } catch (e) {
          try {
            const errEnv = envelope('respond', { error: { code: 5000, message: String(e?.message ?? e), retryable: true } }, cfg)
            const signed = ctx.identity ? signEnvelope(errEnv, ctx.identity) : errEnv
            if (typeof msg.respond === 'function') msg.respond(j(signed))
          } catch { /* best-effort */ }
        }
      })()
    }
  })()
  loop.catch(() => {})
  return () => { stopped = true; try { sub.unsubscribe() } catch { /* best-effort */ } }
}

/** Map a ReactorPro skill id to an RTerm handler. Returns {output} or {error}. */
export async function executeSkill(skillId, input, ctx) {
  const skills = (typeof ctx.getSkills === 'function' ? ctx.getSkills() : ctx.skills) || {}
  const handler = skills[skillId]
  if (!handler) {
    return { error: { code: 3001, message: `SKILL_NOT_FOUND: ${skillId}`, retryable: false } }
  }
  try {
    const output = await handler(input ?? {}, ctx)
    return { output: output ?? {} }
  } catch (e) {
    return { error: { code: 5000, message: String(e?.message ?? e), retryable: true } }
  }
}

// ─── 4. HEARTBEAT ────────────────────────────────────────────────────────────

/** Publish a signed heartbeat (liveness + id-collision detection). */
export function heartbeat(nc, cfg, identity) {
  const env = envelope('heartbeat', { ts: new Date().toISOString() }, cfg)
  nc.publish(`${cfg.prefix}.heartbeat.${cfg.agentId}`, j(signEnvelope(env, identity)))
}

/** Start a periodic signed heartbeat. Returns a stop function. */
export function startHeartbeat(nc, cfg, identity, intervalMs = 30000, log = () => {}) {
  try { heartbeat(nc, cfg, identity) } catch (e) { log(`[reactorpro] heartbeat failed: ${e?.message ?? e}`) }
  const t = setInterval(() => {
    try { heartbeat(nc, cfg, identity) } catch (e) { log(`[reactorpro] heartbeat failed: ${e?.message ?? e}`) }
  }, intervalMs)
  return () => clearInterval(t)
}

// ─── 5. REGISTRY ─────────────────────────────────────────────────────────────

/** The manifest this RTerm advertises.
 *
 * SHAPE CONTRACT (mirrors the gateway's Manifest struct, envelope.go:146):
 *   id            — json:"id" (NOT "identity"; manifestMatches drops a
 *                   manifest whose ID is empty, so the old `identity` key made
 *                   this peer invisible to gateway discovery)
 *   skills        — []{id, name?, description?} objects, NOT bare strings
 *                   (the gateway's Skill struct unmarshals objects)
 *   fingerprint   — json:"fingerprint,omitempty" — pins trust-on-first-use
 * The register/discover payloads are the BARE manifest (the gateway's
 * Register/handleDiscoverRequest both attachPayload(manifest) directly), so
 * callers must not nest it under a "manifest" key. */
export function buildManifest(cfg, skillIds) {
  const skills = (skillIds ?? []).map((s) =>
    typeof s === 'string' ? { id: s, name: s } : s)
  return {
    id: cfg.agentId,
    name: cfg.name ?? cfg.agentId,
    capabilities: ['rterm', 'agent', ...(cfg.capabilities ?? [])],
    skills,
    fingerprint: cfg.fingerprint ?? null,
    local_agents: [{ id: cfg.agentId, name: cfg.name ?? cfg.agentId, capabilities: ['rterm', 'agent'] }],
  }
}

/** Register with the mesh registry (mesh.registry.register).
 * Payload is the BARE manifest — the gateway's Register does
 * attachPayload(envelope, a.Manifest()) with no wrapper object. */
export function registerManifest(nc, cfg, identity, manifest) {
  const env = envelope('register', manifest, cfg, { to: 'REGISTRY' })
  nc.publish(`${cfg.prefix}.registry.register`, j(signEnvelope(env, identity)))
}

/** Graceful exit. */
export function deregisterManifest(nc, cfg, identity) {
  const env = envelope('register', { id: cfg.agentId, gone: true }, cfg, { to: 'REGISTRY' })
  nc.publish(`${cfg.prefix}.registry.deregister`, j(signEnvelope(env, identity)))
}

/** Answer discovery broadcasts with our manifest.
 * The reply payload is the BARE manifest — the gateway's
 * handleDiscoverRequest does attachPayload(reply, manifest), and its
 * manifestsFrom accepts either {agents:[...]} or a bare manifest with
 * id != "". Nesting under "manifest" would make it invisible. */
export async function answerDiscovery(nc, cfg, identity, manifest, log = () => {}) {
  const subject = `${cfg.prefix}.registry.discover`
  const sub = nc.subscribe(subject)
  let stopped = false
  const loop = (async () => {
    for await (const msg of sub) {
      if (stopped) break
      try {
        if (isPublishAck(msg.data)) continue
        const req = uj(msg.data)
        if (req?.from === cfg.agentId) continue // don't answer ourselves
        if (msg.reply) {
          const env = envelope('respond', manifest, cfg, { to: req?.from, in_reply_to: req?.id })
          nc.publish(msg.reply, j(signEnvelope(env, identity)))
        }
      } catch (e) { log(`[reactorpro] discovery answer failed: ${e?.message ?? e}`) }
    }
  })()
  loop.catch(() => {})
  return () => { stopped = true; try { sub.unsubscribe() } catch { /* best-effort */ } }
}
