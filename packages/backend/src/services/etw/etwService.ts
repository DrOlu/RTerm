import { randomUUID } from 'crypto'

/**
 * EtwService — ETW Tier: built-in Windows ETW diagnostics (no install, no AV risk).
 *
 * Drives Windows' native ETW tooling (logman / wevtutil / Get-WinEvent / Get-Counter)
 * over WinRM to collect network/file/registry/process events and performance
 * counters, parses the output into structured events, and feeds the SRE ledgers
 * and agent RCA. Pure + injectable: command execution is injected (WinRM
 * executeCommand); session-building and output-parsing are pure.
 */

// --- ETW provider catalog (built into Windows) ---
export const ETW_PROVIDERS = {
  network: 'Microsoft-Windows-Kernel-Network',
  file: 'Microsoft-Windows-Kernel-File',
  registry: 'Microsoft-Windows-Kernel-Registry',
  process: 'Microsoft-Windows-Kernel-Process',
  dns: 'Microsoft-Windows-DNS-Client',
  power: 'Microsoft-Windows-Kernel-Power',
} as const

export type EtwProviderKind = keyof typeof ETW_PROVIDERS

export interface EtwSession {
  id: string
  name: string
  providers: EtwProviderKind[]
  outFile: string
  createdAt: number
}

export interface EtwEvent {
  at?: string
  provider?: string
  message: string
  processName?: string
  pid?: number
  /** parsed fields when available (ip, port, path, key). */
  fields?: Record<string, string>
}

export interface EtwDeps {
  now?: () => number
}

const now0 = () => Date.now()

/** Pure: build the logman commands to start a session for the given providers. */
export function buildStartCommands(session: EtwSession): string[] {
  const cmds: string[] = []
  for (const kind of session.providers) {
    const provider = ETW_PROVIDERS[kind]
    const name = `${session.name}-${kind}`
    cmds.push(`logman create trace "${name}" -p "${provider}" -o "${session.outFile}-${kind}.etl" -ets`)
  }
  return cmds
}

/** Pure: build the logman stop command(s) for a session. */
export function buildStopCommands(session: EtwSession): string[] {
  return session.providers.map((kind) => `logman stop "${session.name}-${kind}" -ets`)
}

/** Pure: build a Get-WinEvent query (PowerShell, JSON output). */
export function buildWinEventQuery(logName: string, maxEvents = 100, filter?: string): string {
  const filterPart = filter ? ` | Where-Object { ${filter} }` : ''
  return `Get-WinEvent -LogName '${logName}' -MaxEvents ${maxEvents}${filterPart} | Select-Object TimeCreated,Id,ProviderName,Message | ConvertTo-Json -Depth 3 -Compress`
}

/** Pure: build a Get-Counter query (PowerShell, JSON output). */
export function buildCounterQuery(counterPath: string, samples = 1): string {
  return `Get-Counter -Counter '${counterPath}' -MaxSamples ${samples} | Select-Object -ExpandProperty CounterSamples | Select-Object Path,CookedValue | ConvertTo-Json -Depth 3 -Compress`
}

/** Pure: parse Get-WinEvent JSON output into EtwEvent[]. Tolerant of single-object
 * (non-array) JSON and text fallbacks. */
export function parseWinEventJson(output: string): EtwEvent[] {
  const trimmed = output.trim()
  if (!trimmed) return []
  let parsed: unknown
  try { parsed = JSON.parse(trimmed) } catch { return parseWinEventText(trimmed) }
  const arr = Array.isArray(parsed) ? parsed : [parsed]
  const out: EtwEvent[] = []
  for (const item of arr) {
    const o = item as { TimeCreated?: string; Id?: number; ProviderName?: string; Message?: string }
    if (!o || typeof o !== 'object') continue
    const message = (o.Message ?? '').toString().trim()
    if (!message) continue
    out.push({
      at: o.TimeCreated,
      provider: o.ProviderName,
      message,
      fields: extractFields(message),
    })
  }
  return out
}

/** Parse plain-text wevtutil/Get-WinEvent output into EtwEvent[]. */
export function parseWinEventText(output: string): EtwEvent[] {
  const out: EtwEvent[] = []
  const blocks = output.split(/\r?\n\r?\n/)
  for (const b of blocks) {
    const msg = b.trim()
    if (!msg) continue
    out.push({ message: msg.split(/\r?\n/).slice(0, 4).join(' '), fields: extractFields(msg) })
  }
  return out
}

/** Pure: extract useful fields (ip, port, path, key, process) from a message. */
export function extractFields(message: string): Record<string, string> {
  const fields: Record<string, string> = {}
  const ip = message.match(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/)
  if (ip) fields.ip = ip[1]
  const port = message.match(/[Pp]ort[:\s]+(\d{1,5})/)
  if (port) fields.port = port[1]
  const path = message.match(/([A-Za-z]:\\[^\s"',;]+)/)
  if (path) fields.path = path[1]
  const key = message.match(/(HKLM|HKCU|HKCR|HKU)\\[^\s"',;]+/i)
  if (key) fields.key = key[0]
  const proc = message.match(/[Pp]rocess(?:Name)?[:\s]+([A-Za-z0-9_.-]+\.exe)/)
  if (proc) fields.processName = proc[1]
  const pid = message.match(/[Pp]rocess\s*[Ii]d[:\s]+(\d+)/)
  if (pid) fields.pid = pid[1]
  return fields
}

/** Pure: parse Get-Counter JSON output into {path,value} points. */
export function parseCounterJson(output: string): Array<{ path: string; value: number }> {
  const trimmed = output.trim()
  if (!trimmed) return []
  let parsed: unknown
  try { parsed = JSON.parse(trimmed) } catch { return [] }
  const arr = Array.isArray(parsed) ? parsed : [parsed]
  const out: Array<{ path: string; value: number }> = []
  for (const item of arr) {
    const o = item as { Path?: string; CookedValue?: number | string }
    if (!o || o.Path === undefined) continue
    const value = typeof o.CookedValue === 'number' ? o.CookedValue : parseFloat(String(o.CookedValue ?? 'NaN'))
    if (Number.isFinite(value)) out.push({ path: o.Path, value })
  }
  return out
}

/** Pure: top-N counter points by value (e.g. top CPU-consuming processes). */
export function topCounters(points: Array<{ path: string; value: number }>, n = 5): Array<{ path: string; value: number }> {
  return points.slice().sort((a, b) => b.value - a.value).slice(0, n)
}

export class EtwService {
  private readonly sessions = new Map<string, EtwSession>()
  private readonly now: () => number

  constructor(deps: EtwDeps = {}) {
    this.now = deps.now ?? now0
  }

  /** Create a session descriptor (commands are built from it by buildStartCommands). */
  createSession(name: string, providers: EtwProviderKind[], outDir = 'C:\\temp'): EtwSession {
    const clean = name.replace(/[^A-Za-z0-9_-]/g, '')
    const s: EtwSession = {
      id: `etw-${randomUUID().slice(0, 8)}`,
      name: clean,
      providers,
      outFile: `${outDir}\\${clean}`,
      createdAt: this.now(),
    }
    this.sessions.set(s.id, s)
    return s
  }

  session(id: string): EtwSession | undefined {
    return this.sessions.get(id)
  }

  sessions_(): readonly EtwSession[] {
    return Array.from(this.sessions.values())
  }

  removeSession(id: string): boolean {
    return this.sessions.delete(id)
  }

  clear(): void {
    this.sessions.clear()
  }
}
