import type { CommandTask, CommandResult } from '../types'

/**
 * captureStatus.extreme.spec — tests for v3.2.5 Feature 1:
 * Reliable command-output semantics (capture status: complete/partial/truncated)
 */

const tests: Array<{ name: string; run: () => void }> = []
function test(name: string, run: () => void) { tests.push({ name, run }) }
function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message}. expected=${String(expected)} actual=${String(actual)}`)
}

// ─── Simulate the captureStatus logic from finalizeActiveTask ────────────────
const MAX_BUFFER_SIZE = 200000

function resolveCaptureStatus(task: Pick<CommandTask, 'capturedOutput' | 'output'>): CommandTask['captureStatus'] {
  if (task.capturedOutput !== undefined && task.capturedOutput.length < (task.output || '').length) {
    return 'partial'
  } else if ((task.output || '').length > MAX_BUFFER_SIZE) {
    return 'display-truncated'
  } else {
    return 'complete'
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test('captureStatus is "complete" when output fits within buffer and capturedOutput matches', () => {
  const task = { output: 'hello world\n', capturedOutput: 'hello world\n' }
  assertEqual(resolveCaptureStatus(task), 'complete', 'small output with matching capture should be complete')
})

test('captureStatus is "complete" when capturedOutput is undefined but output is small', () => {
  const task = { output: 'hello\n', capturedOutput: undefined }
  assertEqual(resolveCaptureStatus(task), 'complete', 'no captured output but small should be complete')
})

test('captureStatus is "partial" when capturedOutput is shorter than resolved output', () => {
  const task = { output: 'full output here\nmore output\n', capturedOutput: 'full output here\n' }
  assertEqual(resolveCaptureStatus(task), 'partial', 'captured shorter than output should be partial')
})

test('captureStatus is "display-truncated" when output exceeds MAX_BUFFER_SIZE', () => {
  const bigOutput = 'x'.repeat(MAX_BUFFER_SIZE + 1)
  const task = { output: bigOutput, capturedOutput: bigOutput }
  assertEqual(resolveCaptureStatus(task), 'display-truncated', 'output exceeding buffer should be display-truncated')
})

test('captureStatus is "complete" when output exactly equals MAX_BUFFER_SIZE', () => {
  const exactOutput = 'x'.repeat(MAX_BUFFER_SIZE)
  const task = { output: exactOutput, capturedOutput: exactOutput }
  assertEqual(resolveCaptureStatus(task), 'complete', 'output exactly at buffer limit should be complete')
})

test('CommandResult includes captureStatus field', () => {
  const result: CommandResult = {
    stdoutDelta: 'output',
    exitCode: 0,
    history_command_match_id: 'task-1',
    captureStatus: 'complete',
  }
  assertEqual(result.captureStatus, 'complete', 'CommandResult should carry captureStatus')
})

test('CommandResult.captureStatus is optional (backward compatible)', () => {
  const result: CommandResult = {
    stdoutDelta: 'output',
    exitCode: 0,
    history_command_match_id: 'task-1',
  }
  assertEqual(result.captureStatus, undefined, 'captureStatus should be optional')
})

test('captureStatus "partial" takes priority over "display-truncated" when both conditions are true', () => {
  // If capturedOutput is shorter than output AND output exceeds buffer,
  // partial is the more important signal (data was lost, not just clipped)
  const bigOutput = 'x'.repeat(MAX_BUFFER_SIZE + 100)
  const task = { output: bigOutput, capturedOutput: 'x'.repeat(100) }
  assertEqual(resolveCaptureStatus(task), 'partial', 'partial should take priority over display-truncated')
})

// ─── Runner ─────────────────────────────────────────────────────────────────
function main() {
  let pass = 0, fail = 0
  for (const t of tests) {
    try { t.run(); pass++; console.log(`PASS ${t.name}`) }
    catch (e) { fail++; console.log(`FAIL ${t.name}: ${(e as Error).message}`) }
  }
  console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}
main()
