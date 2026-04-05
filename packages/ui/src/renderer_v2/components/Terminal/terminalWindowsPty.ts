import type { IWindowsPty } from '@xterm/xterm'

export type TerminalRemoteOs = 'unix' | 'windows'

export interface TerminalSystemInfoLike {
  release?: string
}

const UNKNOWN_WINDOWS_BUILD = 0
const CONPTY_MIN_WINDOWS_BUILD = 18309

export const parseWindowsBuildNumber = (release?: string): number | undefined => {
  if (typeof release !== 'string') return undefined
  const normalized = release.trim()
  if (!normalized) return undefined

  const match = normalized.match(/^\d+\.\d+\.(\d+)/)
  if (!match) return undefined

  const parsed = Number.parseInt(match[1], 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

export const resolveTerminalWindowsPty = (
  remoteOs?: TerminalRemoteOs,
  systemInfo?: TerminalSystemInfoLike
): IWindowsPty | undefined => {
  if (remoteOs !== 'windows') {
    return undefined
  }

  const buildNumber = parseWindowsBuildNumber(systemInfo?.release) ?? UNKNOWN_WINDOWS_BUILD

  return {
    backend: buildNumber >= CONPTY_MIN_WINDOWS_BUILD ? 'conpty' : 'winpty',
    // Prefer a safe compatibility posture until the exact Windows build arrives.
    buildNumber
  }
}

export const windowsPtyOptionsEqual = (
  left?: IWindowsPty,
  right?: IWindowsPty
): boolean =>
  (left?.backend || undefined) === (right?.backend || undefined) &&
  (left?.buildNumber ?? undefined) === (right?.buildNumber ?? undefined)
