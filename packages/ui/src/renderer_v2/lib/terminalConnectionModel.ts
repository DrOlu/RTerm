import {
  getTerminalConnectionCapabilities,
  getTerminalConnectionTypeDefinition,
  type TerminalConnectionCapabilities,
  type TerminalConnectionIconKind,
} from '@gyshell/shared'
import type { TerminalConfig } from './ipcTypes'

export interface TerminalConnectionRef {
  type: string
  entryId?: string
}

export const resolveTerminalConnectionCapabilities = (
  config: Pick<TerminalConfig, 'type'> | { type: string },
): TerminalConnectionCapabilities =>
  getTerminalConnectionCapabilities(config.type)

export const supportsFilesystemForTerminalConfig = (
  config: Pick<TerminalConfig, 'type'> | { type: string },
): boolean => resolveTerminalConnectionCapabilities(config).supportsFilesystem

export const getTerminalConnectionIconKind = (
  type: string,
): TerminalConnectionIconKind =>
  getTerminalConnectionTypeDefinition(type).iconKind

export const resolveTerminalRuntimeIndicatorState = (
  type: string,
  runtimeState: 'initializing' | 'ready' | 'exited',
): 'initializing' | 'ready' | 'exited' | 'inactive' => {
  const iconKind = getTerminalConnectionIconKind(type)
  if (iconKind === 'remote') {
    return runtimeState === 'ready' ? 'ready' : 'inactive'
  }
  return runtimeState
}

/** v3.0.5: is the tab currently auto-reconnecting (reconnectState.scheduled)? */
export const isTerminalReconnecting = (tab: {
  reconnectState?: { scheduled?: boolean; gaveUp?: boolean } | null
}): boolean => tab.reconnectState?.scheduled === true

/** The trailing indicator state including the reconnecting variant (v3.0.5). */
export const resolveTerminalTabIndicator = (
  type: string,
  runtimeState: 'initializing' | 'ready' | 'exited',
  tab?: { reconnectState?: { scheduled?: boolean; gaveUp?: boolean } | null },
): 'initializing' | 'ready' | 'exited' | 'inactive' | 'reconnecting' => {
  if (isTerminalReconnecting(tab ?? {})) return 'reconnecting'
  return resolveTerminalRuntimeIndicatorState(type, runtimeState)
}

