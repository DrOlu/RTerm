import fs from 'node:fs'
import path from 'node:path'
import type { TerminalConfig } from '../../types'

export interface PersistedTerminalRecord {
  id: string
  config: TerminalConfig
}

interface PersistedTerminalStatePayload {
  schemaVersion: 1
  updatedAt: number
  terminals: PersistedTerminalRecord[]
}

const CURRENT_SCHEMA_VERSION = 1 as const

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const asPositiveInt = (value: unknown, fallback: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback
  }
  return Math.max(1, Math.floor(value))
}

const normalizeTerminalConfig = (raw: unknown): TerminalConfig | null => {
  if (!isObject(raw)) return null
  const type = raw.type === 'ssh' ? 'ssh' : raw.type === 'local' ? 'local' : null
  if (!type) return null

  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  const title = typeof raw.title === 'string' ? raw.title.trim() : ''
  if (!id || !title) return null

  const cols = asPositiveInt(raw.cols, 80)
  const rows = asPositiveInt(raw.rows, 24)

  if (type === 'local') {
    return {
      type: 'local',
      id,
      title,
      cols,
      rows,
      ...(typeof raw.cwd === 'string' && raw.cwd.trim() ? { cwd: raw.cwd } : {}),
      ...(typeof raw.shell === 'string' && raw.shell.trim() ? { shell: raw.shell } : {})
    }
  }

  if (typeof raw.host !== 'string' || !raw.host.trim()) return null
  const port = asPositiveInt(raw.port, 22)
  if (typeof raw.username !== 'string' || !raw.username.trim()) return null
  const authMethod = raw.authMethod === 'privateKey' ? 'privateKey' : raw.authMethod === 'password' ? 'password' : null
  if (!authMethod) return null

  return {
    type: 'ssh',
    id,
    title,
    cols,
    rows,
    host: raw.host,
    port,
    username: raw.username,
    authMethod,
    ...(typeof raw.password === 'string' ? { password: raw.password } : {}),
    ...(typeof raw.privateKey === 'string' ? { privateKey: raw.privateKey } : {}),
    ...(typeof raw.privateKeyPath === 'string' ? { privateKeyPath: raw.privateKeyPath } : {}),
    ...(typeof raw.passphrase === 'string' ? { passphrase: raw.passphrase } : {}),
    ...(isObject(raw.proxy) ? { proxy: raw.proxy as any } : {}),
    ...(Array.isArray(raw.tunnels) ? { tunnels: raw.tunnels as any } : {}),
    ...(isObject(raw.jumpHost) ? { jumpHost: raw.jumpHost as any } : {})
  }
}

const normalizeRecord = (raw: unknown): PersistedTerminalRecord | null => {
  if (!isObject(raw)) return null
  const config = normalizeTerminalConfig(raw.config)
  if (!config) return null
  const id = typeof raw.id === 'string' ? raw.id.trim() : config.id
  if (!id) return null
  return {
    id,
    config: {
      ...config,
      id
    }
  }
}

const normalizePayload = (raw: unknown): PersistedTerminalStatePayload => {
  if (!isObject(raw)) {
    return {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      updatedAt: Date.now(),
      terminals: []
    }
  }

  const seen = new Set<string>()
  const terminals: PersistedTerminalRecord[] = []
  const input = Array.isArray(raw.terminals) ? raw.terminals : []
  input.forEach((item) => {
    const normalized = normalizeRecord(item)
    if (!normalized) return
    if (seen.has(normalized.id)) return
    seen.add(normalized.id)
    terminals.push(normalized)
  })

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    updatedAt: Date.now(),
    terminals
  }
}

export class TerminalStateStore {
  constructor(private readonly stateFilePath: string) {}

  load(): PersistedTerminalRecord[] {
    try {
      if (!fs.existsSync(this.stateFilePath)) return []
      const raw = fs.readFileSync(this.stateFilePath, 'utf8')
      const parsed = JSON.parse(raw)
      const payload = normalizePayload(parsed)
      return payload.terminals
    } catch (error) {
      console.warn('[TerminalStateStore] Failed to read terminal state file:', error)
      return []
    }
  }

  save(terminals: PersistedTerminalRecord[]): void {
    const payload = normalizePayload({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      updatedAt: Date.now(),
      terminals
    })

    const dirPath = path.dirname(this.stateFilePath)
    const tempFilePath = `${this.stateFilePath}.tmp-${process.pid}-${Date.now()}`

    try {
      fs.mkdirSync(dirPath, { recursive: true })
      fs.writeFileSync(tempFilePath, JSON.stringify(payload, null, 2), 'utf8')
      fs.renameSync(tempFilePath, this.stateFilePath)
    } catch (error) {
      console.warn('[TerminalStateStore] Failed to persist terminal state file:', error)
      try {
        if (fs.existsSync(tempFilePath)) {
          fs.rmSync(tempFilePath, { force: true })
        }
      } catch {
        // ignore cleanup errors
      }
    }
  }
}
