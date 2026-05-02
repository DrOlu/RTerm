export type TerminalRecoveryReason = 'resume' | 'unlock-screen' | 'display-metrics-changed'

export interface TerminalRefitRequest {
  forceBackendResize: boolean
  clearTextureAtlas: boolean
}

export interface TerminalBackendResizeFailure {
  cols: number
  rows: number
}

export const NORMAL_TERMINAL_REFIT_REQUEST: Readonly<TerminalRefitRequest> = Object.freeze({
  forceBackendResize: false,
  clearTextureAtlas: false
})

export const RECOVERY_TERMINAL_REFIT_REQUEST: Readonly<TerminalRefitRequest> = Object.freeze({
  forceBackendResize: false,
  clearTextureAtlas: true
})

export const mergeTerminalRefitRequests = (
  base: TerminalRefitRequest,
  next: TerminalRefitRequest
): TerminalRefitRequest => ({
  forceBackendResize: base.forceBackendResize || next.forceBackendResize,
  clearTextureAtlas: base.clearTextureAtlas || next.clearTextureAtlas
})

export const shouldSendTerminalBackendResize = (options: {
  previousCols: number
  previousRows: number
  nextCols: number
  nextRows: number
  forceBackendResize?: boolean
  failedBackendResize?: TerminalBackendResizeFailure | null
}): boolean =>
  options.forceBackendResize === true ||
  options.previousCols !== options.nextCols ||
  options.previousRows !== options.nextRows ||
  (
    options.failedBackendResize?.cols === options.nextCols &&
    options.failedBackendResize?.rows === options.nextRows
  )

export const normalizeTerminalRecoveryReason = (value: unknown): TerminalRecoveryReason | null => {
  if (value === 'resume' || value === 'unlock-screen' || value === 'display-metrics-changed') {
    return value
  }
  return null
}

export const shouldScheduleTerminalRecoveryOnActivate = (options: {
  recoveryEpoch: number
  lastHandledRecoveryEpoch: number
  pendingRecoveryRefit?: boolean
}): boolean =>
  options.pendingRecoveryRefit === true ||
  options.lastHandledRecoveryEpoch < options.recoveryEpoch
