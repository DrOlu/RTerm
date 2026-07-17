import type { SSHConnectionEntry } from '../../types'

/**
 * Import PuTTY saved sessions into RTerm SSHConnectionEntry[].
 *
 * PuTTY stores sessions in the Windows registry under
 * HKCU\Software\SimonTatham\PuTTY\Sessions\<name>, each a registry key with
 * values like HostName, PortNumber, UserName, Protocol, etc. Users export a
 * `.reg` file (Windows Registry Editor format) which we parse here. We also
 * accept a JSON form (key → { values }) for programmatic import.
 *
 * The PuTTY session NAME becomes the RTerm connection name (session names are
 * often paths like "Data%20Center/core-rtr-01"; we URL-decode and use the last
 * segment as the name).
 */

export interface PuttySessionValues {
  HostName?: string
  PortNumber?: number
  UserName?: string
  Protocol?: string
  Password?: string // only if the user stored it (rare; usually prompt)
  [k: string]: unknown
}

export type PuttyImportSource =
  | { format: 'reg'; content: string }
  | { format: 'json'; content: Record<string, PuttySessionValues> }

function decodeSessionName(name: string): string {
  // PuTTY session key names are URL-escaped (%20 etc.). Use the last segment.
  const last = name.split('\\').pop() ?? name
  try {
    return decodeURIComponent(last)
  } catch {
    return last
  }
}

function regUnquote(s: string): string {
  return s.replace(/^"|"$/g, '').replace(/\\(?=.)/g, '')
}

/**
 * Parse a Windows .reg export (REGEDIT4 or "Windows Registry Editor Version 5.00").
 * Returns a map of sessionName → values.
 */
export function parsePuttyReg(content: string): Record<string, PuttySessionValues> {
  const out: Record<string, PuttySessionValues> = {}
  const lines = content.split(/\r?\n/)
  let current: { name: string; values: PuttySessionValues } | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // Match a session key header: [HKEY_CURRENT_USER\Software\SimonTatham\PuTTY\Sessions\MyServer]
    const header = line.match(/^\[.*?\\Software\\SimonTatham\\PuTTY\\Sessions\\(.+)\]$/i)
    if (header) {
      const name = decodeSessionName(header[1])
      current = { name, values: {} }
      out[name] = current.values
      continue
    }
    // Match a generic key end (empty []) — stop current.
    if (/^\[/.test(line)) { current = null; continue }
    if (!current) continue
    // Match "ValueName"=type:value  or  "ValueName"=dword:0000001b  or  "ValueName"="string"
    const m = line.match(/^"([^"]+)"=(?:"([^"]*)"|(dword):([0-9a-fA-F]+))$/)
    if (m) {
      const key = m[1]
      if (m[2] !== undefined) current.values[key] = regUnquote(m[2])
      else if (m[3] === 'dword') current.values[key] = parseInt(m[4], 16)
    }
  }
  return out
}

/** Convert parsed PuTTY sessions to SSHConnectionEntry[] (ssh only; telnet/serial skipped). */
export function puttySessionsToEntries(
  sessions: Record<string, PuttySessionValues>,
  opts: { idPrefix?: string } = {},
): SSHConnectionEntry[] {
  const entries: SSHConnectionEntry[] = []
  for (const [name, v] of Object.entries(sessions)) {
    const proto = (v.Protocol ?? 'ssh').toLowerCase()
    if (proto !== 'ssh') continue // skip raw/telnet/serial
    const host = v.HostName?.trim()
    if (!host) continue
    entries.push({
      id: `${opts.idPrefix ?? 'putty'}-${name.replace(/[^a-z0-9_-]+/gi, '_')}`,
      name,
      host,
      port: typeof v.PortNumber === 'number' && v.PortNumber > 0 ? v.PortNumber : 22,
      username: v.UserName?.trim() || '',
      authMethod: 'password',
      password: v.Password,
      notes: `Imported from PuTTY session`,
    })
  }
  return entries
}

/** One-shot: parse + convert a .reg string into SSHConnectionEntry[]. */
export function importPuttyReg(content: string, opts?: { idPrefix?: string }): SSHConnectionEntry[] {
  return puttySessionsToEntries(parsePuttyReg(content), opts)
}
