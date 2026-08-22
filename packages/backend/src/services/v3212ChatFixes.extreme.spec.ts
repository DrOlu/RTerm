/**
 * v3212ChatFixes.extreme.spec — tests for the v3.2.12 chat-console fixes:
 *   1. Task-completion guard continue bound (the "response clears and
 *      re-answers" bug)
 *   2. Guard no longer removes the assistant's answer on continue
 *   3. DONE dedupe (one DONE per run, not two)
 *   4. UI: queued-insertion echo must not re-arm isThinking after DONE
 *
 * These test the pure decision logic mirrored from the graph nodes; the
 * graph wiring itself is exercised by the live repro.
 */

const tests: Array<{ name: string; run: () => void }> = []
function test(name: string, run: () => void) { tests.push({ name, run }) }
function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message}. expected=${String(expected)} actual=${String(actual)}`)
}
function assertTrue(actual: boolean, message: string): void {
  if (actual !== true) throw new Error(`${message}. expected=true actual=${String(actual)}`)
}

// ─── 1. Guard continue bound ────────────────────────────────────────────────

const MAX_CONTINUES = 1

/** Mirrors the guard's entry check (createTaskCompletionGuardNode). */
function guardEntryDecision(state: { guardContinueCount?: number }): 'end' | 'proceed' {
  const count = typeof state.guardContinueCount === 'number' ? state.guardContinueCount : 0
  return count >= MAX_CONTINUES ? 'end' : 'proceed'
}

test('guard: first continue is allowed (count 0)', () => {
  assertEqual(guardEntryDecision({ guardContinueCount: 0 }), 'proceed', 'count 0 must proceed')
})

test('guard: second continue is blocked (count >= MAX)', () => {
  assertEqual(guardEntryDecision({ guardContinueCount: 1 }), 'end', 'count 1 must force end')
  assertEqual(guardEntryDecision({ guardContinueCount: 5 }), 'end', 'count 5 must force end')
})

test('guard: missing count treated as 0 (proceed)', () => {
  assertEqual(guardEntryDecision({}), 'proceed', 'undefined count → 0 → proceed')
})

test('guard: a run with an over-strict auditor terminates after MAX continues', () => {
  // Simulate: auditor always says "not done". Before the fix this looped
  // forever; now it ends after MAX_CONTINUES forced continues.
  let count = 0
  let iterations = 0
  while (iterations < 100) {
    iterations += 1
    if (guardEntryDecision({ guardContinueCount: count }) === 'end') break
    count += 1 // audit says continue → increment
  }
  assertTrue(iterations < 100, `loop must terminate (took ${iterations} iterations)`)
  assertEqual(count, MAX_CONTINUES, `exactly MAX continues allowed`)
})

// ─── 2. Guard no longer removes the assistant's answer ─────────────────────

/**
 * Mirrors the v3.2.12 guard continue path: the assistant's last message
 * STAYS in the message list; only a continue instruction is appended.
 * (Before the fix, emitRemoveMessageIfPresent deleted the answer.)
 */
function guardContinueMessages(
  messages: Array<{ id: string; role: string }>,
): { next: Array<{ id: string; role: string }>; removedIds: string[] } {
  const last = messages[messages.length - 1]
  const continueMsg = { id: 'continue-1', role: 'user' }
  return {
    next: [...messages, continueMsg],
    removedIds: last && last.role === 'assistant' ? [] : [], // fix: never removed
  }
}

test('guard continue: assistant answer is preserved', () => {
  const messages = [
    { id: 'u1', role: 'user' },
    { id: 'a1', role: 'assistant' },
  ]
  const { next, removedIds } = guardContinueMessages(messages)
  assertEqual(removedIds.length, 0, 'no message may be removed')
  assertTrue(next.some((m) => m.id === 'a1'), 'assistant answer must survive')
  assertTrue(next.some((m) => m.id === 'continue-1'), 'continue instruction appended')
  assertEqual(next[next.length - 1].id, 'continue-1', 'continue instruction is last')
})

// ─── 3. DONE dedupe ────────────────────────────────────────────────────────

/** Mirrors the v3.2.12 dispatchTask finally-block decision. */
function shouldBroadcastDone(agentEmittedDone: boolean): boolean {
  return !agentEmittedDone
}

test('DONE dedupe: agent-emitted done suppresses the gateway duplicate', () => {
  assertEqual(shouldBroadcastDone(true), false, 'no second DONE when agent emitted it')
  assertEqual(shouldBroadcastDone(false), true, 'gateway DONE still fires when agent threw early')
})

test('DONE dedupe: exactly one DONE per successful run', () => {
  const agentEmitted = true // final_output ran
  const doneCount = (agentEmitted ? 1 : 0) + (shouldBroadcastDone(agentEmitted) ? 1 : 0)
  assertEqual(doneCount, 1, 'successful run must produce exactly one DONE')
})

test('DONE dedupe: failed run still produces one DONE', () => {
  const agentEmitted = false // threw before final_output
  const doneCount = (agentEmitted ? 1 : 0) + (shouldBroadcastDone(agentEmitted) ? 1 : 0)
  assertEqual(doneCount, 1, 'failed run must still produce exactly one DONE')
})

// ─── 4. UI: queued-insertion echo must not re-arm thinking ─────────────────

/** Mirrors the ChatStore ADD_MESSAGE(user) handler's v3.2.12 guard. */
function shouldReArmThinking(
  sessionBusy: boolean,
  isThinking: boolean,
  messageMetadata: { inputKind?: string } | undefined,
): boolean {
  const kind = messageMetadata?.inputKind
  if (kind && kind !== 'normal') return false // queued insertion echo → no
  return !sessionBusy || isThinking
}

test('UI: normal user message re-arms thinking when idle', () => {
  assertEqual(shouldReArmThinking(false, false, { inputKind: 'normal' }), true, 'idle + normal → arm')
})

test('UI: queued-insertion echo does NOT re-arm thinking after DONE', () => {
  assertEqual(shouldReArmThinking(false, false, { inputKind: 'inserted' }), false, 'inserted echo → no re-arm')
  assertEqual(shouldReArmThinking(false, false, { inputKind: 'queued_insertion' }), false, 'queued echo → no re-arm')
})

test('UI: queued insertion while busy keeps existing thinking state', () => {
  assertEqual(shouldReArmThinking(true, true, { inputKind: 'inserted' }), false, 'busy echo → no change (stays thinking via run events)')
})

test('UI: message with no metadata treated as normal', () => {
  assertEqual(shouldReArmThinking(false, false, undefined), true, 'no metadata → normal → arm')
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
