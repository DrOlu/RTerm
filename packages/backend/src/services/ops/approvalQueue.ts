/**
 * Queued HITL with TTL auto-deny (v3.8.0).
 */

export type ApprovalState = 'pending' | 'approved' | 'denied' | 'expired'

export interface Approval {
  id: string
  command: string
  requestedAt: number
  expiresAt: number
  state: ApprovalState
  twoPerson: boolean
  votes: string[]
}

const q = new Map<string, Approval>()
let seq = 0

export function requestApproval(command: string, ttlMs: number, twoPerson = false, now = Date.now()): Approval {
  const id = `apr-${++seq}`
  const a: Approval = {
    id,
    command,
    requestedAt: now,
    expiresAt: now + ttlMs,
    state: 'pending',
    twoPerson,
    votes: [],
  }
  q.set(id, a)
  return a
}

export function decide(id: string, who: string, approve: boolean, now = Date.now()): Approval {
  const a = q.get(id)
  if (!a) throw new Error('unknown approval')
  if (now > a.expiresAt) {
    a.state = 'expired'
    return a
  }
  if (!approve) {
    a.state = 'denied'
    return a
  }
  if (!a.votes.includes(who)) a.votes.push(who)
  if (a.twoPerson && a.votes.length < 2) return a
  a.state = 'approved'
  return a
}

export function sweepExpired(now = Date.now()): number {
  let n = 0
  for (const a of q.values()) {
    if (a.state === 'pending' && now > a.expiresAt) {
      a.state = 'expired'
      n++
    }
  }
  return n
}
