import type { IWindowsPty } from '@xterm/xterm'

export type TerminalRemoteOs = 'unix' | 'windows'

export interface TerminalSystemInfoLike {
  release?: string
}

const UNKNOWN_WINDOWS_BUILD = 0

export const parseWindowsBuildNumber = (release?: string): number | undefined => {
  if (typeof release !== 'string') return undefined
  const normalized = release.trim()
  if (!normalized) return undefined

  const segments = normalized.split('.')
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const rawSegment = segments[index]?.trim()
    if (!rawSegment) continue
    if (!/^\d+$/.test(rawSegment)) continue
    const parsed = Number.parseInt(rawSegment, 10)
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed
    }
  }

  return undefined
}

export const resolveTerminalWindowsPty = (
  remoteOs?: TerminalRemoteOs,
  systemInfo?: TerminalSystemInfoLike
): IWindowsPty | undefined => {
  if (remoteOs !== 'windows') {
    return undefined
  }

  return {
    backend: 'conpty',
    // Prefer a safe compatibility posture until the exact Windows build arrives.
    buildNumber: parseWindowsBuildNumber(systemInfo?.release) ?? UNKNOWN_WINDOWS_BUILD
  }
}

export const windowsPtyOptionsEqual = (
  left?: IWindowsPty,
  right?: IWindowsPty
): boolean =>
  (left?.backend || undefined) === (right?.backend || undefined) &&
  (left?.buildNumber ?? undefined) === (right?.buildNumber ?? undefined)
