/**
 * isRetryableError — the retry classifier (v3.8.4).
 *
 * WHY THIS EXISTS: the classifier previously retried EVERY non-abort error
 * (it was literally `!isAbortError`), so deterministic failures burned four
 * attempts and ~13s of backoff before failing anyway.
 *
 * The subtle case is the one this spec pins: an EMPTY response can be either
 *
 *   finish_reason=error           -> provider-side, often transient -> RETRY
 *   finish_reason=length          -> truncated answer, repeats       -> FAIL FAST
 *   finish_reason=content_filter  -> policy block, repeats           -> FAIL FAST
 *
 * Both arrive as the SAME thrown message
 *   "Model stream ended with an empty unusable response (finish_reason=X)."
 * so the two must be separated on the finish reason, not the wording. A prior
 * revision matched the blanket substring "finish_reason=" and killed the
 * provider-error retry — an existing behavioural spec asserts it must retry.
 *
 * Run:  npx tsx packages/backend/src/services/AgentHelper/utils/runtimeRetry.extreme.spec.ts
 */
import { isRetryableError } from './runtime'

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(
      `${message}. expected=${String(expected)} actual=${String(actual)}`,
    )
  }
}

let passed = 0
const runCase = (name: string, fn: () => void): void => {
  fn()
  passed += 1
  console.log(`PASS ${name}`)
}

const emptyFinish = (reason: string): Error =>
  new Error(
    `Model stream ended with an empty unusable response (finish_reason=${reason}).`,
  )

// ------------------------------------------------ the split (the whole point)
runCase('empty response with finish_reason=error RETRIES (provider-side)', () => {
  assertEqual(
    isRetryableError(emptyFinish('error')),
    true,
    'a provider error finish is transient and must retry',
  )
})

runCase('empty response with finish_reason=length FAILS FAST (truncation)', () => {
  assertEqual(
    isRetryableError(emptyFinish('length')),
    false,
    'a truncated answer repeats on the same input, so retrying is pure latency',
  )
})

runCase('empty response with finish_reason=content_filter FAILS FAST', () => {
  assertEqual(
    isRetryableError(emptyFinish('content_filter')),
    false,
    'a policy block repeats on the same input',
  )
})

runCase('a mixed reason list containing error still RETRIES', () => {
  assertEqual(
    isRetryableError(emptyFinish('length, error')),
    true,
    'if any reason is the provider error, the attempt is worth repeating',
  )
})

runCase('unknown finish reason falls through to the other heuristics', () => {
  // Not a reason this classifier recognises; the message still says "empty
  // unusable response", which is deterministic, so it must not be retried.
  assertEqual(
    isRetryableError(emptyFinish('weird_provider_token')),
    false,
    'an unrecognised reason must not become retryable by accident',
  )
})

// ------------------------------------------------------------ aborts
runCase('abort errors never retry', () => {
  const abort = new Error('The operation was aborted')
  abort.name = 'AbortError'
  assertEqual(isRetryableError(abort), false, 'abort is not retryable')
})

// ------------------------------------------------------------ transient
runCase('transient transport failures still retry', () => {
  for (const msg of [
    'socket hang up',
    'read ECONNRESET',
    'connect ETIMEDOUT',
    'request timed out',
    '503 Service Unavailable',
    '429 Too Many Requests',
    'fetch failed',
  ]) {
    assertEqual(isRetryableError(new Error(msg)), true, `${msg} should retry`)
  }
})

// ------------------------------------------------------------ deterministic
runCase('deterministic failures fail fast', () => {
  for (const msg of [
    'Cannot read properties of undefined (reading \'map\')',
    'message.toDict is not a function',
    '400 Bad Request',
    'invalid_api_key',
    'insufficient_quota',
    'context length exceeded',
    'model_not_found',
  ]) {
    assertEqual(isRetryableError(new Error(msg)), false, `${msg} should fail fast`)
  }
})

runCase('a non-error value is not retryable', () => {
  assertEqual(isRetryableError(undefined), false, 'undefined is not retryable')
  assertEqual(isRetryableError({}), false, 'an empty object is not retryable')
})

console.log(`\n${passed} passed, 0 failed`)
console.log('runtimeRetry: ALL TESTS PASSED')
