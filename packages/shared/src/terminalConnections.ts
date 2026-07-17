export interface TerminalConnectionCapabilities {
  supportsFilesystem: boolean
  supportsMonitor: boolean
}

export type TerminalConnectionIconKind = 'local' | 'remote' | 'generic'

export interface KnownTerminalConnectionTypeDefinition {
  type: KnownTerminalConnectionType
  idPrefix: string
  defaultTitle: string
  iconKind: TerminalConnectionIconKind
  capabilities: TerminalConnectionCapabilities
}

export const KNOWN_TERMINAL_CONNECTION_TYPES = ['local', 'ssh', 'winrm'] as const

export type KnownTerminalConnectionType =
  (typeof KNOWN_TERMINAL_CONNECTION_TYPES)[number]

export interface TerminalConnectionTypeDefinition {
  type: string
  idPrefix: string
  defaultTitle: string
  iconKind: TerminalConnectionIconKind
  capabilities: TerminalConnectionCapabilities
  isKnown: boolean
}

const KNOWN_TERMINAL_CONNECTION_TYPE_DEFINITIONS: Record<
  KnownTerminalConnectionType,
  KnownTerminalConnectionTypeDefinition
> = {
  local: {
    type: 'local',
    idPrefix: 'local',
    defaultTitle: 'Local',
    iconKind: 'local',
    capabilities: {
      supportsFilesystem: true,
      supportsMonitor: true,
    },
  },
  ssh: {
    type: 'ssh',
    idPrefix: 'ssh',
    defaultTitle: 'SSH',
    iconKind: 'remote',
    capabilities: {
      supportsFilesystem: true,
      supportsMonitor: true,
    },
  },
  winrm: {
    type: 'winrm',
    idPrefix: 'winrm',
    defaultTitle: 'WinRM',
    iconKind: 'remote',
    // WinRM v1 is scoped to command execution + the fleet tools, rendered as
    // a command/response log (not a PTY). No file panel / monitor over WinRM.
    capabilities: {
      supportsFilesystem: false,
      supportsMonitor: false,
    },
  },
}

const FALLBACK_TERMINAL_CONNECTION_TYPE_DEFINITION: TerminalConnectionTypeDefinition =
  {
    type: 'terminal',
    idPrefix: 'terminal',
    defaultTitle: 'Terminal',
    iconKind: 'generic',
    capabilities: {
      supportsFilesystem: false,
      supportsMonitor: false,
    },
    isKnown: false,
  }

export const isKnownTerminalConnectionType = (
  value: unknown,
): value is KnownTerminalConnectionType =>
  typeof value === 'string' &&
  Object.prototype.hasOwnProperty.call(
    KNOWN_TERMINAL_CONNECTION_TYPE_DEFINITIONS,
    value,
  )

export const getKnownTerminalConnectionTypeDefinition = (
  type: KnownTerminalConnectionType,
): KnownTerminalConnectionTypeDefinition =>
  KNOWN_TERMINAL_CONNECTION_TYPE_DEFINITIONS[type]

export const getTerminalConnectionTypeDefinition = (
  type: unknown,
): TerminalConnectionTypeDefinition => {
  if (!isKnownTerminalConnectionType(type)) {
    return FALLBACK_TERMINAL_CONNECTION_TYPE_DEFINITION
  }
  return {
    ...KNOWN_TERMINAL_CONNECTION_TYPE_DEFINITIONS[type],
    isKnown: true,
  }
}

export const getTerminalConnectionCapabilities = (
  type: unknown,
): TerminalConnectionCapabilities =>
  getTerminalConnectionTypeDefinition(type).capabilities

export const supportsFilesystemForTerminalConnectionType = (
  type: unknown,
): boolean => getTerminalConnectionCapabilities(type).supportsFilesystem

