/**
 * Named multi-hop path with TTL break-glass (v3.8.0).
 */

export interface JumpHop {
  connectionName: string
  role: 'jump' | 'target'
}

export interface JumpPath {
  name: string
  hops: JumpHop[]
  breakGlassUntil?: number
}

const paths = new Map<string, JumpPath>()

export function defineJumpPath(name: string, hops: JumpHop[]): JumpPath {
  const p = { name, hops: [...hops] }
  paths.set(name, p)
  return p
}

export function grantBreakGlass(name: string, ttlMs: number, now = Date.now()): JumpPath {
  const p = paths.get(name)
  if (!p) throw new Error(`unknown path ${name}`)
  p.breakGlassUntil = now + ttlMs
  return p
}

export function pathAllowed(name: string, now = Date.now()): boolean {
  const p = paths.get(name)
  if (!p) return false
  if (!p.breakGlassUntil) return true
  return now <= p.breakGlassUntil
}
