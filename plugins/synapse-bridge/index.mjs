/**
 * synapse-bridge — RTerm ↔ Synapse mesh interop.
 *
 * Lets RTerm speak the Synapse protocol (v0.3.0) over a shared NATS server:
 * discover live mesh agents, dispatch tasks to them, and register RTerm itself
 * as a mesh agent (bidirectional federation). Built on the same NatsEventBus
 * conventions (auth, request/reply, JetStream) added in v3.1.2.
 *
 * Config (settings.synapse, or env):
 *   url        — NATS server (default nats://localhost:4222)
 *   servers    — array of urls (takes precedence)
 *   prefix     — mesh subject prefix (default "mesh")
 *   agentId    — this instance's mesh agent id (default "rterm-001")
 *   auth       — { token | username/password | nkeySeed | jwt/jwtSeed | creds | tls* }
 *   enabled    — master switch (default true when a server is configured)
 *
 * Secrets may be inline or `secretRef` pointers resolved via the vault.
 */

import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import {
  startResponder, buildRespond, executeSkill,
  emitEvent, subscribeEvents,
  ReputationStore, computeScore, updateRecord, newRecord,
  requestApproval, respondApproval, startApprover,
} from './synapseAgent.mjs'

const require = createRequire(import.meta.url)
const enc = new TextEncoder()
const dec = new TextDecoder()
const j = (v) => enc.encode(JSON.stringify(v))
const uj = (b) => JSON.parse(dec.decode(b))

// ─── config resolution ──────────────────────────────────────────────────────

export function resolveConfig(ctx = {}, env = process.env) {
  const s = (typeof ctx.getSettings === 'function' ? ctx.getSettings() : ctx.settings) || {}
  const block = s.synapse || {}
  const servers = Array.isArray(block.servers) && block.servers.length > 0
    ? block.servers
    : (block.url || env.SYNAPSE_NATS_URL || env.NATS_URL || 'nats://localhost:4222')
  return {
    servers,
    prefix: block.prefix || 'mesh',
    agentId: block.agentId || env.SYNAPSE_AGENT_ID || 'rterm-001',
    auth: block.auth || undefined,
    enabled: block.enabled !== false,
  }
}

/** Resolve auth secrets through the vault when secretRef-style values are used. */
function resolveAuth(ctx, auth) {
  if (!auth) return undefined
  const out = { ...auth }
  if (out.passwordSecretRef && typeof ctx.getSecret === 'function') {
    try { out.password = ctx.getSecret(out.passwordSecretRef); delete out.passwordSecretRef } catch { /* leave unset */ }
  }
  if (out.tokenSecretRef && typeof ctx.getSecret === 'function') {
    try { out.token = ctx.getSecret(out.tokenSecretRef); delete out.tokenSecretRef } catch { /* leave unset */ }
  }
  return out
}

// ─── transport (lazy NATS connection) ───────────────────────────────────────

function loadTransport() {
  try { return require('@nats-io/transport-node') } catch {
    throw new Error('NATS transport (@nats-io/transport-node) is not available in this build')
  }
}

function buildAuthenticator(t, auth) {
  if (!auth) return undefined
  const e = new TextEncoder()
  if (auth.creds) return t.credsAuthenticator(typeof auth.creds === 'string' ? e.encode(auth.creds) : auth.creds)
  if (auth.jwt) return t.jwtAuthenticator(auth.jwt, typeof auth.jwtSeed === 'string' ? e.encode(auth.jwtSeed) : auth.jwtSeed)
  if (auth.nkeySeed) return t.nkeyAuthenticator(typeof auth.nkeySeed === 'string' ? e.encode(auth.nkeySeed) : auth.nkeySeed)
  if (auth.token) return t.tokenAuthenticator(auth.token)
  if (auth.username !== undefined) return t.usernamePasswordAuthenticator(auth.username, auth.password ?? '')
  return undefined
}

// Connection cache keyed by config fingerprint — a settings change (different
// server/auth/agentId) opens a NEW connection instead of reusing a stale one to
// the wrong server. A failed connect clears the slot so the next call retries.
const _conns = new Map() // key -> Promise<conn> | conn
function _configKey(cfg) {
  const servers = Array.isArray(cfg.servers) ? cfg.servers.join(',') : cfg.servers
  const authKeys = cfg.auth ? Object.keys(cfg.auth).sort().join(',') : ''
  return `${servers}|${cfg.agentId}|${authKeys}`
}

async function connectMesh(ctx) {
  const cfg = resolveConfig(ctx)
  const key = _configKey(cfg)
  const existing = _conns.get(key)
  if (existing) {
    const c = await existing
    if (c && !c.isClosed()) return c
    _conns.delete(key) // stale/closed — fall through and reconnect
  }
  const t = loadTransport()
  const auth = buildAuthenticator(t, resolveAuth(ctx, cfg.auth))
  const copts = { servers: cfg.servers, name: cfg.agentId, ...(auth ? { authenticator: auth } : {}) }
  const connectFn = (typeof ctx.natsConnect === 'function') ? ctx.natsConnect : (o) => t.connect(o)
  const p = (async () => {
    try {
      return await connectFn(copts)
    } catch (e) {
      _conns.delete(key) // don't cache a failed attempt — allow retry
      throw e
    }
  })()
  _conns.set(key, p)
  return p
}

/** Test hook: inject a fake connection for a given config (or clear all with null). */
export function __setConnForTest(c, cfg) {
  if (c === null || c === undefined) { _conns.clear(); return }
  const key = _configKey(cfg ?? resolveConfig({ settings: {} }))
  _conns.set(key, Promise.resolve(c))
}

// ─── Synapse envelope ───────────────────────────────────────────────────────

export function envelope(type, payload, cfg, extra = {}) {
  return {
    v: '0.3.0',
    id: randomUUID(),
    type,
    ts: new Date().toISOString(),
    from: cfg.agentId,
    trace: { trace_id: randomUUID(), span_id: randomUUID() },
    payload,
    ...extra,
  }
}

// ─── core ops ───────────────────────────────────────────────────────────────

export async function discoverAgents(ctx, filter = {}) {
  const cfg = resolveConfig(ctx)
  const nc = await connectMesh(ctx)
  const msg = await nc.request(`${cfg.prefix}.registry.discover`, j(envelope('discover', filter, cfg)), { timeout: 4000 })
  const reply = uj(msg.data)
  const agents = Array.isArray(reply) ? reply : (reply.payload?.agents ?? reply.payload ?? reply)
  return Array.isArray(agents) ? agents : []
}

export async function dispatchTask(ctx, target, skill, input = {}, opts = {}) {
  const cfg = resolveConfig(ctx)
  const nc = await connectMesh(ctx)
  const env = envelope('request', { skill, input }, cfg, { to: target, task_id: randomUUID() })
  const msg = await nc.request(`${cfg.prefix}.agent.${target}.inbox`, j(env), { timeout: opts.timeout ?? 30000 })
  return uj(msg.data)
}

export async function registerSelf(ctx, manifest = {}) {
  const cfg = resolveConfig(ctx)
  const nc = await connectMesh(ctx)
  const payload = {
    agent_id: cfg.agentId,
    name: manifest.name || 'RTerm / neuralOS',
    type: 'agent',
    capabilities: manifest.capabilities || ['ops-automation', 'playbooks', 'fleet-orchestration', 'mop-changes'],
    skills: manifest.skills || [],
    endpoint: `${cfg.prefix}.agent.${cfg.agentId}.inbox`,
    availability: 'online',
    ...manifest,
  }
  nc.publish(`${cfg.prefix}.registry.register`, j(envelope('register', payload, cfg)))
  return { registered: cfg.agentId, endpoint: payload.endpoint }
}

// ─── plugin registration ────────────────────────────────────────────────────

async function guarded(fn, log) {
  try { return await fn() } catch (e) {
    const msg = e?.message ?? String(e)
    log?.(`[synapse] ${msg}`)
    return { error: msg, hint: 'Is the NATS server running and the synapse block configured? (settings.synapse.url, default nats://localhost:4222).' }
  }
}

export function register(ctx) {
  const { registerTool, registerTrigger, registerPanel, log } = ctx
  const cfg = resolveConfig(ctx)

  registerTool({
    name: 'synapse_health',
    description: 'Check connectivity to the Synapse mesh (NATS server) and report the configured agent id + subject prefix.',
    params: {},
    handler: async () => guarded(async () => {
      const nc = await connectMesh(ctx)
      return { connected: !nc.isClosed(), agentId: cfg.agentId, prefix: cfg.prefix, servers: cfg.servers }
    }, log),
  })

  registerTool({
    name: 'synapse_discover',
    description: 'Discover live Synapse mesh agents and their skills via the registry (mesh.registry.discover). Optional filter by capabilities/skill_ids/availability.',
    params: {
      capabilities: { type: 'array', description: 'Capabilities to match (all-of)', optional: true },
      skill_ids: { type: 'array', description: 'Skill ids to match (all-of)', optional: true },
      availability: { type: 'string', description: 'e.g. online', optional: true },
    },
    handler: async (p) => guarded(async () => {
      const filter = {}
      if (p?.capabilities) filter.capabilities = p.capabilities
      if (p?.skill_ids) filter.skill_ids = p.skill_ids
      if (p?.availability) filter.availability = p.availability
      const agents = await discoverAgents(ctx, filter)
      return { count: agents.length, agents }
    }, log),
  })

  registerTool({
    name: 'synapse_dispatch',
    description: 'Dispatch a task to a Synapse mesh agent (mesh.agent.{id}.inbox) and await its response. The task is durably tracked in the mesh.',
    params: {
      target: { type: 'string', description: 'Target agent id (e.g. grip-cli-001)' },
      skill: { type: 'string', description: 'Skill id from the target manifest' },
      input: { type: 'object', description: 'Input payload for the skill', optional: true },
      timeout: { type: 'number', description: 'Reply timeout ms (default 30000)', optional: true },
    },
    handler: async (p) => guarded(async () => {
      if (!p?.target || !p?.skill) return { error: 'synapse_dispatch needs target and skill' }
      const response = await dispatchTask(ctx, p.target, p.skill, p.input ?? {}, { timeout: p.timeout })
      return { target: p.target, skill: p.skill, response }
    }, log),
  })

  registerTool({
    name: 'synapse_register',
    description: 'Register this RTerm/neuralOS instance as a Synapse mesh agent (mesh.registry.register) so other mesh agents can discover and dispatch to it.',
    params: {
      name: { type: 'string', optional: true },
      capabilities: { type: 'array', optional: true },
      skills: { type: 'array', optional: true },
    },
    handler: async (p) => guarded(async () => registerSelf(ctx, p ?? {}), log),
  })

  registerTool({
    name: 'synapse_agents_summary',
    description: 'Compact summary of live Synapse mesh agents (id, name, skill count, first skills) for quick situational awareness.',
    params: {},
    handler: async () => guarded(async () => {
      const agents = await discoverAgents(ctx, {})
      return {
        count: agents.length,
        agents: agents.map((a) => ({
          id: a.id ?? a.agent_id ?? a.name,
          name: a.name,
          skillCount: (a.skills ?? a.capabilities ?? []).length,
          skills: (a.skills ?? a.capabilities ?? []).slice(0, 5).map((s) => (typeof s === 'string' ? s : s.id ?? s.name)),
        })),
      }
    }, log),
  })

  // ─── full-duplex agent capabilities (responder, emit/subscribe, reputation, governance) ───
  const repStore = new ReputationStore()
  let responderStop = null

  registerTool({
    name: 'synapse_serve',
    description: 'Start RTerm as a full Synapse agent: listen on mesh.agent.{id}.inbox and respond() to incoming Synapse requests by mapping them to RTerm skills (playbooks/tools via ctx.rtermSkills / getRtermSkills). Bidirectional federation — other agents can now task RTerm.',
    params: {
      skills: { type: 'object', description: 'Map of skillId -> async (input, ctx) => output, the skills RTerm serves', optional: true },
    },
    handler: async (p) => guarded(async () => {
      const nc = await connectMesh(ctx)
      const serveCtx = { ...ctx, rtermSkills: p?.skills ?? ctx.rtermSkills ?? {} }
      if (responderStop) responderStop() // idempotent: restart with fresh skills
      responderStop = await startResponder(nc, cfg, serveCtx, log)
      const skillIds = Object.keys(serveCtx.rtermSkills)
      return { serving: true, inbox: `${cfg.prefix}.agent.${cfg.agentId}.inbox`, skills: skillIds, note: 'RTerm is now a full Synapse agent (responder live)' }
    }, log),
  })

  registerTool({
    name: 'synapse_emit',
    description: 'Emit a formal Synapse event on mesh.event.{type} (fire-and-forget broadcast to subscribers).',
    params: {
      type: { type: 'string', description: 'Event type, e.g. ops.change.committed' },
      payload: { type: 'object', description: 'Event payload' },
    },
    handler: async (p) => guarded(async () => {
      if (!p?.type) return { error: 'synapse_emit needs a type' }
      const nc = await connectMesh(ctx)
      emitEvent(nc, cfg, p.type, p.payload ?? {})
      return { emitted: `${cfg.prefix}.event.${p.type}` }
    }, log),
  })

  registerTool({
    name: 'synapse_subscribe',
    description: 'Subscribe to Synapse event/task subjects (supports wildcards, e.g. mesh.event.> or mesh.task.>.update). Events feed the local reputation store and the synapse_mesh_event trigger.',
    params: {
      subject: { type: 'string', description: 'Subject pattern, e.g. mesh.event.> or mesh.task.>.update' },
    },
    handler: async (p) => guarded(async () => {
      const subject = p?.subject ?? `${cfg.prefix}.task.>.update`
      const nc = await connectMesh(ctx)
      const stop = await subscribeEvents(nc, subject, (env, subj) => {
        repStore.handleTaskUpdate(env)
        if (typeof ctx.emitEvent === 'function') ctx.emitEvent({ source: 'synapse', subject: subj, env })
      })
      return { subscribed: subject, note: 'events feed the reputation store + synapse_mesh_event trigger' }
    }, log),
  })

  registerTool({
    name: 'synapse_reputation',
    description: 'Read the local Synapse reputation store (EXT-REPUTATION): per (agent, skill) success_rate, speed_score, freshness, composite score. Optionally record an outcome or list ranked agents.',
    params: {
      agent: { type: 'string', optional: true },
      skill: { type: 'string', optional: true },
      minScore: { type: 'number', description: 'Only agents at/above this score (discover-ranked)', optional: true },
    },
    handler: async (p) => guarded(async () => {
      if (p?.agent && p?.skill) {
        const rec = repStore.get(p.agent, p.skill)
        return rec ?? { error: `no record for ${p.agent}::${p.skill}` }
      }
      const ranked = repStore.ranked(p?.minScore ?? 0)
      return { count: ranked.length, agents: ranked.map((r) => ({ agent: r.agent_id, skill: r.skill, score: Number(r.score.toFixed(3)), successRate: Number(r.success_rate.toFixed(3)), speedScore: Number(r.speed_score.toFixed(3)), confidence: r.confidence })) }
    }, log),
  })

  registerTool({
    name: 'synapse_request_approval',
    description: 'Request governance approval for a gated action (EXT-GOVERNANCE): publish mesh.approval.{taskId}.request and await the response. Use before a high-risk dispatched task.',
    params: {
      originalRequest: { type: 'object', description: 'The original request payload being gated' },
      policyId: { type: 'string', optional: true },
      ruleId: { type: 'string', optional: true },
      reason: { type: 'string', description: 'Why approval is required' },
      taskId: { type: 'string', optional: true },
      timeout: { type: 'number', optional: true },
    },
    handler: async (p) => guarded(async () => {
      const nc = await connectMesh(ctx)
      const r = await requestApproval(nc, cfg, { taskId: p?.taskId, originalRequest: p?.originalRequest, policyId: p?.policyId, ruleId: p?.ruleId, reason: p?.reason ?? 'RTerm action requires mesh approval', timeout: p?.timeout })
      return r.approved ? { approved: true, approver: r.approver, taskId: r.taskId } : { approved: false, taskId: r.taskId, note: 'denied or timed out' }
    }, log),
  })

  registerTool({
    name: 'synapse_approve',
    description: 'Act as a governance approver (EXT-GOVERNANCE): listen on mesh.approval.*.request and answer each per a policy (allow-all, deny-all, or a decide map). Other agents route their gated actions through RTerm for approval.',
    params: {
      policy: { type: 'string', description: 'allow-all | deny-all (default allow-all)', optional: true },
    },
    handler: async (p) => guarded(async () => {
      const nc = await connectMesh(ctx)
      const policy = p?.policy ?? 'allow-all'
      const decide = async () => ({ approved: policy !== 'deny-all', approver: `did:mesh:${cfg.agentId}` })
      await startApprover(nc, cfg, decide, log)
      return { approver: cfg.agentId, policy, listening: `${cfg.prefix}.approval.*.request` }
    }, log),
  })

  registerTrigger({
    name: 'synapse_mesh_event',
    description: 'Fires when a Synapse mesh event (task failure, reputation penalty, approval request) is observed. Use for cross-mesh remediation.',
    match: (event) => event?.source === 'synapse',
    action: 'propose-change',
  })

  registerPanel({
    name: 'synapse-mesh-agents',
    title: 'Synapse Mesh Agents',
    render: (data) => {
      const rows = (Array.isArray(data) ? data : []).map((a) =>
        `<tr><td>${a.id ?? ''}</td><td>${a.name ?? ''}</td><td>${a.skillCount ?? ''}</td></tr>`
      ).join('')
      return `<div class="synapse-mesh"><h3>Synapse Mesh Agents</h3><p>Agent: ${cfg.agentId} · Prefix: ${cfg.prefix}</p><table><thead><tr><th>Id</th><th>Name</th><th>Skills</th></tr></thead><tbody>${rows}</tbody></table></div>`
    },
  })

  log(`[synapse] synapse-bridge registered: 11 tools, 1 trigger, 1 panel (agent=${cfg.agentId}, prefix=${cfg.prefix}, full-duplex)`)
}

export default { register, resolveConfig, envelope, discoverAgents, dispatchTask, registerSelf }
