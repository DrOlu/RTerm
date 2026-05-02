import {
  mergeTerminalRefitRequests,
  normalizeTerminalRecoveryReason,
  RECOVERY_TERMINAL_REFIT_REQUEST,
  shouldScheduleTerminalRecoveryOnActivate,
  shouldSendTerminalBackendResize,
  NORMAL_TERMINAL_REFIT_REQUEST
} from './terminalRecovery'

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(`${message}. expected=${String(expected)} actual=${String(actual)}`)
  }
}

const runCase = (name: string, fn: () => void): void => {
  fn()
  console.log(`PASS ${name}`)
}

runCase('mergeTerminalRefitRequests preserves renderer recovery flags', () => {
  const merged = mergeTerminalRefitRequests(
    { ...NORMAL_TERMINAL_REFIT_REQUEST },
    { ...RECOVERY_TERMINAL_REFIT_REQUEST }
  )
  assertEqual(merged.forceBackendResize, false, 'renderer-only recovery should not force backend resize')
  assertEqual(merged.clearTextureAtlas, true, 'recovery merge should clear texture atlas')
})

runCase('shouldSendTerminalBackendResize keeps normal same-size refits side-effect free', () => {
  assertEqual(
    shouldSendTerminalBackendResize({
      previousCols: 120,
      previousRows: 30,
      nextCols: 120,
      nextRows: 30,
      forceBackendResize: false
    }),
    false,
    'same-size normal refits should not send a backend resize'
  )
})

runCase('shouldSendTerminalBackendResize keeps same-size recovery refits renderer-only', () => {
  assertEqual(
    shouldSendTerminalBackendResize({
      previousCols: 120,
      previousRows: 30,
      nextCols: 120,
      nextRows: 30,
      forceBackendResize: RECOVERY_TERMINAL_REFIT_REQUEST.forceBackendResize
    }),
    false,
    'same-size recovery refits should not resend PTY size to the backend'
  )
})

runCase('shouldSendTerminalBackendResize preserves explicit backend resize overrides', () => {
  assertEqual(
    shouldSendTerminalBackendResize({
      previousCols: 120,
      previousRows: 30,
      nextCols: 120,
      nextRows: 30,
      forceBackendResize: true
    }),
    true,
    'explicit backend resize overrides should still force a backend resize'
  )
})

runCase('shouldSendTerminalBackendResize retries a failed same-size backend resize', () => {
  assertEqual(
    shouldSendTerminalBackendResize({
      previousCols: 118,
      previousRows: 30,
      nextCols: 118,
      nextRows: 30,
      forceBackendResize: RECOVERY_TERMINAL_REFIT_REQUEST.forceBackendResize,
      failedBackendResize: { cols: 118, rows: 30 }
    }),
    true,
    'same-size recovery refits should retry a previously failed backend resize'
  )
})

runCase('shouldSendTerminalBackendResize ignores stale failed resize targets', () => {
  assertEqual(
    shouldSendTerminalBackendResize({
      previousCols: 118,
      previousRows: 30,
      nextCols: 118,
      nextRows: 30,
      forceBackendResize: RECOVERY_TERMINAL_REFIT_REQUEST.forceBackendResize,
      failedBackendResize: { cols: 120, rows: 30 }
    }),
    false,
    'failed resize retries should only target the current terminal size'
  )
})

runCase('shouldSendTerminalBackendResize still resizes the backend for real geometry changes', () => {
  assertEqual(
    shouldSendTerminalBackendResize({
      previousCols: 120,
      previousRows: 30,
      nextCols: 118,
      nextRows: 30,
      forceBackendResize: RECOVERY_TERMINAL_REFIT_REQUEST.forceBackendResize
    }),
    true,
    'actual terminal geometry changes should still reach the backend'
  )
})

runCase('normalizeTerminalRecoveryReason rejects unexpected renderer payloads', () => {
  assertEqual(
    normalizeTerminalRecoveryReason('resume'),
    'resume',
    'known recovery reasons should survive normalization'
  )
  assertEqual(
    normalizeTerminalRecoveryReason('window-focus'),
    null,
    'unknown recovery reasons should be ignored'
  )
})

runCase('shouldScheduleTerminalRecoveryOnActivate preserves deferred recovery work for hidden tabs', () => {
  assertEqual(
    shouldScheduleTerminalRecoveryOnActivate({
      recoveryEpoch: 3,
      lastHandledRecoveryEpoch: 3,
      pendingRecoveryRefit: true
    }),
    true,
    'pending recovery should force a recovery refit even when the global epoch did not change'
  )
  assertEqual(
    shouldScheduleTerminalRecoveryOnActivate({
      recoveryEpoch: 5,
      lastHandledRecoveryEpoch: 5,
      pendingRecoveryRefit: false
    }),
    false,
    'activation should stay on the cheap path when there is no pending or global recovery work'
  )
})

console.log('All terminal recovery UI extreme tests passed.')
