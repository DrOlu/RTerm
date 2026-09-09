/**
 * Two operators, one agent session (v3.8.0).
 */

export interface Presence {
  sessionId: string
  operators: string[]
  holder: string | null
}

const rooms = new Map<string, Presence>()

export function joinSession(sessionId: string, operator: string): Presence {
  const r = rooms.get(sessionId) ?? { sessionId, operators: [], holder: null }
  if (!r.operators.includes(operator)) r.operators.push(operator)
  if (!r.holder) r.holder = operator
  rooms.set(sessionId, r)
  return r
}

export function takeConn(sessionId: string, operator: string): Presence {
  const r = rooms.get(sessionId)
  if (!r) throw new Error('no session')
  if (!r.operators.includes(operator)) r.operators.push(operator)
  r.holder = operator
  return r
}

export function whoHasConn(sessionId: string): string | null {
  return rooms.get(sessionId)?.holder ?? null
}
