/**
 * Last-output snapshot / diff per connection (v3.8.0).
 */

export interface Snap {
  connection: string
  command: string
  output: string
  at: number
}

const last = new Map<string, Snap>()

export function rememberOutput(connection: string, command: string, output: string, at = Date.now()): Snap {
  const s = { connection, command, output: String(output ?? ''), at }
  last.set(connection, s)
  return s
}

export function diffLast(connection: string, nextOutput: string): { previous: string | null; current: string; changed: boolean } {
  const prev = last.get(connection)
  const current = String(nextOutput ?? '')
  if (!prev) return { previous: null, current, changed: true }
  return { previous: prev.output, current, changed: prev.output !== current }
}

export function unifiedDiff(a: string, b: string): string {
  if (a === b) return ''
  const al = a.split('\n')
  const bl = b.split('\n')
  const lines: string[] = ['--- previous', '+++ current']
  const n = Math.max(al.length, bl.length)
  for (let i = 0; i < n; i++) {
    const L = al[i]
    const R = bl[i]
    if (L === R) continue
    if (L !== undefined) lines.push('-' + L)
    if (R !== undefined) lines.push('+' + R)
  }
  return lines.join('\n')
}
