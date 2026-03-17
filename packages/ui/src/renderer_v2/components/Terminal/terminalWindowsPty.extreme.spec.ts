import { parseWindowsBuildNumber, resolveTerminalWindowsPty, windowsPtyOptionsEqual } from './terminalWindowsPty'

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(`${message}. expected=${String(expected)} actual=${String(actual)}`)
  }
}

const assertDeepEqual = (actual: unknown, expected: unknown, message: string): void => {
  const actualJson = JSON.stringify(actual)
  const expectedJson = JSON.stringify(expected)
  if (actualJson !== expectedJson) {
    throw new Error(`${message}. expected=${expectedJson} actual=${actualJson}`)
  }
}

const runCase = (name: string, fn: () => void): void => {
  fn()
  console.log(`PASS ${name}`)
}

runCase('parses the Windows build number from a dotted release string', () => {
  assertEqual(parseWindowsBuildNumber('10.0.26100'), 26100, 'should parse the trailing build segment')
})

runCase('ignores invalid Windows release values', () => {
  assertEqual(parseWindowsBuildNumber(''), undefined, 'empty release should not yield a build number')
  assertEqual(parseWindowsBuildNumber('preview-build'), undefined, 'non-numeric release should not yield a build number')
})

runCase('derives a conservative conpty hint for Windows terminals', () => {
  assertDeepEqual(
    resolveTerminalWindowsPty('windows', { release: '10.0.26100' }),
    { backend: 'conpty', buildNumber: 26100 },
    'windows terminals should receive a conpty hint'
  )
})

runCase('falls back to a conservative build number before system info arrives', () => {
  assertDeepEqual(
    resolveTerminalWindowsPty('windows'),
    { backend: 'conpty', buildNumber: 0 },
    'windows terminals should use a fallback build number when needed'
  )
})

runCase('does not enable windows pty hints for non-Windows terminals', () => {
  assertEqual(resolveTerminalWindowsPty('unix'), undefined, 'unix terminals should not receive windows pty hints')
})

runCase('compares windows pty options structurally', () => {
  assertEqual(
    windowsPtyOptionsEqual(
      { backend: 'conpty', buildNumber: 26100 },
      { backend: 'conpty', buildNumber: 26100 }
    ),
    true,
    'matching windows pty options should compare equal'
  )
  assertEqual(
    windowsPtyOptionsEqual(
      { backend: 'conpty', buildNumber: 26100 },
      { backend: 'conpty', buildNumber: 19045 }
    ),
    false,
    'different windows pty options should not compare equal'
  )
})

console.log('All terminal windows pty extreme tests passed.')
