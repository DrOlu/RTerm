import {
  getTerminalConnectionCapabilities,
  getTerminalConnectionTypeDefinition,
} from '@gyshell/shared'
import type {
  GenericConnectionConfig,
  LocalConnectionConfig,
  SSHConnectionConfig,
  TerminalConfig,
} from '../../types'

const asPositiveInt = (value: unknown, fallback: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback
  }
  return Math.max(1, Math.floor(value))
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const resolveRequestedTerminalType = (value: unknown): string => {
  if (typeof value !== 'string') {
    return 'local'
  }
  const normalized = value.trim()
  return normalized || 'local'
}

export const resolveTerminalConnectionCapabilities = (value: {
  type: string
}) => getTerminalConnectionCapabilities(value.type)

export const createAutoTerminalConfig = (
  terminals: Array<{ id: string; title: string; type?: string }>,
  partial: Record<string, unknown> = {},
): Record<string, unknown> => {
  const requestedType = resolveRequestedTerminalType(partial.type)
  const typeDefinition = getTerminalConnectionTypeDefinition(requestedType)
  const ids = new Set(terminals.map((terminal) => terminal.id))
  const typeCount = terminals.filter((terminal) => {
    if (terminal.type === requestedType) {
      return true
    }
    return terminal.id.startsWith(`${typeDefinition.idPrefix}-`)
  }).length

  const nextTerminalId = (() => {
    if (
      typeof partial.id === 'string' &&
      partial.id.trim().length > 0
    ) {
      return partial.id.trim()
    }
    const base =
      requestedType === 'local' ? Math.max(2, typeCount + 1) : typeCount + 1
    let index = base
    let candidate = `${typeDefinition.idPrefix}-${index}`
    while (ids.has(candidate)) {
      index += 1
      candidate = `${typeDefinition.idPrefix}-${index}`
    }
    return candidate
  })()

  const cols =
    Number.isInteger(partial.cols) && Number(partial.cols) > 0
      ? Number(partial.cols)
      : 120
  const rows =
    Number.isInteger(partial.rows) && Number(partial.rows) > 0
      ? Number(partial.rows)
      : 32
  const title =
    typeof partial.title === 'string' && partial.title.trim().length > 0
      ? partial.title.trim()
      : `${typeDefinition.defaultTitle} (${typeCount + 1})`

  return {
    ...partial,
    type: requestedType,
    id: nextTerminalId,
    title,
    cols,
    rows,
  }
}

export const normalizePersistedTerminalConfig = (
  raw: unknown,
): TerminalConfig | null => {
  if (!isObject(raw)) return null
  const type = typeof raw.type === 'string' ? raw.type.trim() : ''
  if (!type) return null

  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  const title = typeof raw.title === 'string' ? raw.title.trim() : ''
  if (!id || !title) return null

  const cols = asPositiveInt(raw.cols, 80)
  const rows = asPositiveInt(raw.rows, 24)

  if (type === 'local') {
    const next: LocalConnectionConfig = {
      type: 'local',
      id,
      title,
      cols,
      rows,
      ...(typeof raw.cwd === 'string' && raw.cwd.trim()
        ? { cwd: raw.cwd }
        : {}),
      ...(typeof raw.shell === 'string' && raw.shell.trim()
        ? { shell: raw.shell }
        : {}),
    }
    return next
  }

  if (type === 'ssh') {
    if (typeof raw.host !== 'string' || !raw.host.trim()) return null
    const port = asPositiveInt(raw.port, 22)
    if (typeof raw.username !== 'string' || !raw.username.trim()) return null
    const authMethod =
      raw.authMethod === 'privateKey'
        ? 'privateKey'
        : raw.authMethod === 'password'
          ? 'password'
          : null
    if (!authMethod) return null

    const next: SSHConnectionConfig = {
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
      ...(typeof raw.privateKey === 'string'
        ? { privateKey: raw.privateKey }
        : {}),
      ...(typeof raw.privateKeyPath === 'string'
        ? { privateKeyPath: raw.privateKeyPath }
        : {}),
      ...(typeof raw.passphrase === 'string'
        ? { passphrase: raw.passphrase }
        : {}),
      // v3.0.6: carry the algorithm preset through persistence/reconnect — dropping
      // it reverted Cisco/legacy tabs to 'modern' on reopen/reconnect, which broke
      // the handshake AND made SFTP init run on devices with no SFTP (the
      // "SFTP unavailable: Not connected" bug).
      ...(raw.algorithmsPreset === 'legacy' || raw.algorithmsPreset === 'cisco' || raw.algorithmsPreset === 'modern'
        ? { algorithmsPreset: raw.algorithmsPreset }
        : {}),
      // v3.0.6: carry the SSH handshake ready-timeout override too (slow legacy
      // negotiation); without it a per-connection override was lost on reopen.
      ...(typeof raw.readyTimeout === 'number' && Number.isFinite(raw.readyTimeout) && raw.readyTimeout > 0
        ? { readyTimeout: raw.readyTimeout }
        : {}),
      ...(isObject(raw.proxy) ? { proxy: raw.proxy as any } : {}),
      ...(Array.isArray(raw.tunnels) ? { tunnels: raw.tunnels as any } : {}),
      ...(isObject(raw.jumpHost) ? { jumpHost: raw.jumpHost as any } : {}),
    }
    return next
  }

  const next: GenericConnectionConfig = {
    ...raw,
    type,
    id,
    title,
    cols,
    rows,
  }
  return next
}
