/**
 * synapseAgent — full-duplex Synapse agent capabilities for RTerm/neuralOS.
 *
 * Implements the four pieces that turn RTerm from a Synapse *client* into a full
 * Synapse *agent* (EXT-GOVERNANCE + EXT-REPUTATION aware):
 *
 *   1. RESPONDER — listen on mesh.agent.{id}.inbox and respond() to incoming
 *      Synapse requests by mapping them to RTerm skills (playbooks/tools).
 *   2. EMIT/SUBSCRIBE — formal Synapse `emit` on mesh.event.{type} + wildcard
 *      subscribe to mesh.event.* / mesh.task.* streams.
 *   3. REPUTATION (EXT-REPUTATION) — observe task outcomes and maintain a local
 *      ReputationRecord per (agent, skill): success_rate, speed_score, freshness,
 *      composite score with lying-penalty + confidence, per Formula 11.5.
 *   4. GOVERNANCE (EXT-GOVERNANCE) — speak mesh.approval.{task_id}.request/.response:
 *      request approval for gated actions and answer approval requests (approver side).
 *
 * Transport is the injected NATS connection from the plugin (connectMesh). All pure
 * logic (score formula, response building, record updates) is dependency-free + testable.
 */

import { randomUUID } from 'node:crypto'
import { envelope } from './index.mjs'

const enc = new TextEncoder()
const dec = new TextDecoder()
const j = (v) => enc.encode(JSON.stringify(v))
const uj = (b) => JSON.parse(dec.decode(b))

// ─── 1. RESPONDER ────────────────────────────────────────────────────────────

/** Build a Synapse respond envelope (payload has output XOR error). */
export function buildRespond(requestEnv, cfg, { output, error } = {}) {
  if (output && error) throw new Error('respond must contain output OR error, not both')
  const payload = error ? { error } : { output: output ?? {} }
  return envelope('respond', payload, cfg, {
    to: requestEnv?.from,
    task_id: requestEnv?.task_id,
    in_reply_to: requestEnv?.id,
  })
}

/** Map a Synapse skill id to an RTerm handler. The plugin supplies handlers for
 * the skills RTerm advertises (playbooks/tools). Returns {output} or {error}. */
export async function executeSkill(skillId, input, ctx) {
  const skills = (typeof ctx.getRtermSkills === 'function' ? ctx.getRtermSkills() : ctx.rtermSkills) || {}
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

/** Start the responder loop: subscribe to mesh.agent.{id}.inbox, execute each
 * request, and respond on the reply inbox. Returns a stop function. */
export async function startResponder(nc, cfg, ctx, log = () => {}) {
  const inbox = `${cfg.prefix}.agent.${cfg.agentId}.inbox`
  const sub = nc.subscribe(inbox)
  let stopped = false
  const loop = (async () => {
    for await (const msg of sub) {
      if (stopped) break
      ;(async () => {
        try {
          const req = uj(msg.data)
          const skillId = req?.payload?.skill
          const input = req?.payload?.input
          log(`[synapse] inbound request from ${req?.from} skill=${skillId} task=${req?.task_id}`)
          const result = await executeSkill(skillId, input, ctx)
          const respond = buildRespond(req, cfg, result)
          msg.respond(j(respond))
        } catch (e) {
          try { msg.respond(j({ error: { code: 5000, message: String(e?.message ?? e), retryable: true } })) } catch { /* best-effort */ }
        }
      })()
    }
  })()
  loop.catch(() => {})
  return () => { stopped = true; try { sub.unsubscribe() } catch {} }
}

// ─── 2. EMIT / SUBSCRIBE ─────────────────────────────────────────────────────

/** Emit a formal Synapse event on mesh.event.{type}. */
export function emitEvent(nc, cfg, eventType, payload, extra = {}) {
  nc.publish(`${cfg.prefix}.event.${eventType}`, j(envelope('emit', payload, cfg, extra)))
}

/** Subscribe to a Synapse event/task subject (supports wildcards). Returns stop fn. */
export async function subscribeEvents(nc, subject, handler) {
  const sub = nc.subscribe(subject)
  const loop = (async () => {
    for await (const msg of sub) {
      try { handler(uj(msg.data), msg.subject) } catch { /* ignore malformed */ }
    }
  })()
  loop.catch(() => {})
  return () => { try { sub.unsubscribe() } catch {} }
}

// ─── 3. REPUTATION (EXT-REPUTATION) ──────────────────────────────────────────

export const REP_WEIGHTS = { success: 0.7, speed: 0.2, freshness: 0.1 }
export const REP_DEFAULTS = { maxLatencyMs: 30000, freshnessHalfLifeHours: 24, minSampleSize: 3 }

/** A ReputationRecord for one (agent, skill) pair. */
export function newRecord(agentId, skill) {
  return {
    agent_id: agentId, skill,
    total: 0, successes: 0, failures: 0, timeouts: 0,
    skill_not_found: 0, overloaded: 0, rate_limited: 0,
    latencies_ms: [],
    success_rate: 0, speed_score: 0, freshness: 1, score: 0, confidence: 0.5,
    flags: { misleading_capabilities: false, consecutive_skill_not_found: 0, last_penalty_at: null, penalty_reason: null },
    last_seen: null,
  }
}

/** Compute composite score per Formula 11.5. Pure. */
export function computeScore(rec, weights = REP_WEIGHTS, defaults = REP_DEFAULTS, now = Date.now()) {
  const outcomes = rec.successes + rec.failures + rec.timeouts
  const success_rate = rec.successes / Math.max(1, outcomes)
  const avgLatency = rec.latencies_ms.length ? rec.latencies_ms.reduce((a, b) => a + b, 0) / rec.latencies_ms.length : 0
  const speed_score = success_rate > 0 ? 1 - Math.min(1, Math.max(0, avgLatency / defaults.maxLatencyMs)) : 0
  const hoursSince = rec.last_seen ? (now - rec.last_seen) / 3600000 : 0
  const freshness = Math.exp(-hoursSince / defaults.freshnessHalfLifeHours)
  const confidence = outcomes >= defaults.minSampleSize ? 1.0 : 0.5
  const lying_penalty = rec.flags.misleading_capabilities ? 0.0 : 1.0
  const raw = weights.success * success_rate + weights.speed * speed_score + weights.freshness * freshness
  const score = raw * lying_penalty * confidence
  return { success_rate, speed_score, freshness, confidence, score }
}

/** Update a record from an observed task outcome. Pure-ish (returns the mutated record).
 * outcome: { status: 'completed'|'failed'|'timeout'|'skill_not_found'|'overloaded'|'rate_limited', latencyMs? } */
export function updateRecord(rec, outcome, defaults = REP_DEFAULTS, now = Date.now()) {
  rec.total += 1
  rec.last_seen = now
  const st = outcome.status
  if (st === 'completed') {
    rec.successes += 1
    rec.flags.consecutive_skill_not_found = 0
    if (typeof outcome.latencyMs === 'number') rec.latencies_ms.push(outcome.latencyMs)
  } else if (st === 'failed') {
    rec.failures += 1
    rec.flags.consecutive_skill_not_found = 0
  } else if (st === 'timeout') {
    rec.timeouts += 1
    rec.flags.consecutive_skill_not_found = 0
  } else if (st === 'skill_not_found') {
    rec.skill_not_found += 1
    rec.flags.consecutive_skill_not_found += 1
    if (rec.flags.consecutive_skill_not_found >= 3) {
      rec.flags.misleading_capabilities = true
      rec.flags.penalty_reason = 'repeated SKILL_NOT_FOUND (lying-agent)'
      rec.flags.last_penalty_at = new Date(now).toISOString()
    }
  } else if (st === 'overloaded') {
    rec.overloaded += 1 // recorded, not scored
  } else if (st === 'rate_limited') {
    rec.rate_limited += 1 // recorded, not scored
  }
  const s = computeScore(rec, REP_WEIGHTS, defaults, now)
  rec.success_rate = s.success_rate
  rec.speed_score = s.speed_score
  rec.freshness = s.freshness
  rec.confidence = s.confidence
  rec.score = s.score
  return rec
}

/** Local ReputationStore: keyed {agent}::{skill}, fed by task_update events. */
export class ReputationStore {
  constructor(defaults = REP_DEFAULTS) {
    this.defaults = defaults
    this.records = new Map()
  }
  key(agentId, skill) { return `${agentId}::${skill}` }
  get(agentId, skill) { return this.records.get(this.key(agentId, skill)) }
  observe(agentId, skill, outcome, now = Date.now()) {
    const k = this.key(agentId, skill)
    let rec = this.records.get(k)
    if (!rec) { rec = newRecord(agentId, skill); this.records.set(k, rec) }
    return updateRecord(rec, outcome, this.defaults, now)
  }
  /** discover-ranked: all records at/above minScore, sorted by score desc. */
  ranked(minScore = 0) {
    return [...this.records.values()].filter((r) => r.score >= minScore).sort((a, b) => b.score - a.score)
  }
  /** Feed a mesh.task.{id}.update event (type task_update with payload {agent, skill, status, latencyMs?}). */
  handleTaskUpdate(env, now = Date.now()) {
    const p = env?.payload ?? {}
    if (!p.agent || !p.skill || !p.status) return null
    return this.observe(p.agent, p.skill, { status: p.status, latencyMs: p.latencyMs }, now)
  }
}

// ─── 4. GOVERNANCE (EXT-GOVERNANCE) ──────────────────────────────────────────

/** Request approval for a gated action: publish mesh.approval.{taskId}.request and
 * await the response. Returns { approved, approver } or { approved: false, error }. */
export async function requestApproval(nc, cfg, { taskId, originalRequest, policyId, ruleId, reason, timeout = 30000 }) {
  const tid = taskId ?? randomUUID()
  const env = envelope('approval_request', {
    original_request: originalRequest ?? {},
    policy_id: policyId,
    rule_id: ruleId,
    reason,
  }, cfg, { task_id: tid })
  const msg = await nc.request(`${cfg.prefix}.approval.${tid}.request`, j(env), { timeout })
  const reply = uj(msg.data)
  const p = reply?.payload ?? reply
  return { approved: p?.approved === true, approver: p?.approver, taskId: tid, raw: reply }
}

/** Answer an approval request (approver side): publish mesh.approval.{taskId}.response. */
export function respondApproval(nc, cfg, requestEnv, { approved, approver }) {
  const tid = requestEnv?.task_id
  const env = envelope('approval_response', { approved: approved === true, approver }, cfg, {
    to: requestEnv?.from,
    task_id: tid,
    in_reply_to: requestEnv?.id,
  })
  nc.publish(`${cfg.prefix}.approval.${tid}.response`, j(env))
  return { answered: tid, approved: approved === true }
}

/** Start an approver loop: subscribe to mesh.approval.*.request and answer each per
 * the supplied decide() function ({approved, approver} or a policy name). Returns stop fn. */
export async function startApprover(nc, cfg, decide, log = () => {}) {
  const sub = nc.subscribe(`${cfg.prefix}.approval.*.request`)
  let stopped = false
  const loop = (async () => {
    for await (const msg of sub) {
      if (stopped) break
      ;(async () => {
        try {
          const req = uj(msg.data)
          const decision = await decide(req)
          respondApproval(nc, cfg, req, decision)
          log(`[synapse] approval ${decision.approved ? 'granted' : 'denied'} for task ${req?.task_id}`)
        } catch (e) {
          log(`[synapse] approval handling error: ${e?.message ?? e}`)
        }
      })()
    }
  })()
  loop.catch(() => {})
  return () => { stopped = true; try { sub.unsubscribe() } catch {} }
}
