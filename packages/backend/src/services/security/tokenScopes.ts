/**
 * Gateway capability tokens (v3.8.0).
 * Empty scopes = full access (legacy tokens).
 */

export const SCOPE_FULL = '*'

export function methodAllowed(method: string, scopes: string[] | undefined | null): boolean {
  if (!scopes || scopes.length === 0) return true
  if (scopes.includes(SCOPE_FULL)) return true
  const m = String(method || '')
  for (const s of scopes) {
    if (s === m) return true
    if (s.endsWith(':*')) {
      const prefix = s.slice(0, -1)
      if (m.startsWith(prefix)) return true
      // terminals:* also matches terminal:list
      if (prefix === 'terminals:' && m.startsWith('terminal:')) return true
    }
    if (s.endsWith('*') && m.startsWith(s.slice(0, -1))) return true
  }
  return false
}

export function parseScopes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.map((x) => String(x).trim()).filter(Boolean)
}
