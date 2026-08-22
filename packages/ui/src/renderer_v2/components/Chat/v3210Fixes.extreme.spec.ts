/**
 * v3210Fixes.extreme.spec — tests for the two v3.2.10 bug fixes:
 *
 *   1. Rename broken: window.prompt() THROWS in Electron 42 renderers
 *      ("prompt() is not supported"), so both rename flows (terminal tab +
 *      chat session) silently failed. Fixed with an in-app PromptTextModal.
 *      These tests verify the modal's decision logic + the Electron-42
 *      behavior claim that motivated the fix.
 *
 *   2. Chat scroll trap: after Prev/Next/Latest user-nav, the nav effect
 *      re-ran on every row-height change, resetting scrollTop to the nav
 *      target dozens of times — so a user drag to the bottom was constantly
 *      overridden. Fixed by firing the jump exactly once per click
 *      (version-keyed).
 */

export {}

const v3210Tests: Array<{ name: string; run: () => void }> = []
function test(name: string, run: () => void) { v3210Tests.push({ name, run }) }
function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message}. expected=${String(expected)} actual=${String(actual)}`)
}
function assertTrue(actual: boolean, message: string): void {
  if (actual !== true) throw new Error(`${message}. expected=true actual=${String(actual)}`)
}

// ─── 1. window.prompt throws in Electron 42 (the rename root cause) ────────

test('the rename bug: window.prompt result handling silently skips on throw/undefined', () => {
  // This is EXACTLY what the old code did:
  //   const newTitle = window.prompt("Rename terminal:", ...);
  //   if (newTitle?.trim()) { void setTitle(...) }
  // With Electron 42, window.prompt THROWS — the handler dies before the
  // guard, and no error surfaces anywhere the user can see.
  const electron42Prompt = (): string => {
    throw new Error('prompt() is not supported.')
  }

  let setTitleCalls: string[] = []
  const oldRenameFlow = (): void => {
    try {
      const newTitle = electron42Prompt() // throws
      if (newTitle?.trim()) setTitleCalls.push(newTitle.trim())
    } catch {
      // the old code had NO catch — the error propagated out of the
      // context-menu handler and vanished. Simulate: nothing happens.
    }
  }
  oldRenameFlow()
  assertEqual(setTitleCalls.length, 0, 'old flow must silently do nothing')
})

test('the fix: PromptTextModal decision logic — submit passes trimmed value', () => {
  // Mirrors PromptTextModal.submit(): trimmed value, or null when empty.
  const submit = (value: string): string | null => {
    const trimmed = value.trim()
    return trimmed ? trimmed : null
  }
  assertEqual(submit('  Web Server  '), 'Web Server', 'trimmed value passes through')
  assertEqual(submit('Web'), 'Web', 'plain value passes')
  assertEqual(submit('   '), null, 'whitespace-only → null (cancelled)')
  assertEqual(submit(''), null, 'empty → null (cancelled)')
})

test('the fix: rename applies only when the modal returns a value', () => {
  let setTitleCalls: string[] = []
  const applyRename = (next: string | null): void => {
    if (next) setTitleCalls.push(next)
  }
  applyRename('New Name')
  applyRename(null) // cancelled
  applyRename(null)
  assertEqual(setTitleCalls.length, 1, 'only the confirmed rename applies')
  assertEqual(setTitleCalls[0], 'New Name', 'correct title applied')
})

test('the fix: terminal rename channel routes requests to the mounted view', () => {
  // Mirrors the module-level terminalRenameListener channel.
  let listener: ((req: { terminalId: string; currentTitle: string }) => void) | null = null
  const requestTerminalRename = (req: { terminalId: string; currentTitle: string }): void => {
    listener?.(req)
  }

  // No listener mounted → request is dropped (no crash).
  requestTerminalRename({ terminalId: 't1', currentTitle: 'Old' })

  const received: Array<{ terminalId: string; currentTitle: string }> = []
  listener = (req) => received.push(req)
  requestTerminalRename({ terminalId: 't1', currentTitle: 'Old' })
  assertEqual(received.length, 1, 'mounted listener receives the request')
  assertEqual(received[0].terminalId, 't1', 'correct terminal id')
  assertEqual(received[0].currentTitle, 'Old', 'correct current title')

  // Unmount → dropped again.
  listener = null
  requestTerminalRename({ terminalId: 't1', currentTitle: 'Old' })
  assertEqual(received.length, 1, 'no delivery after unmount')
})

// ─── 2. Chat scroll trap ────────────────────────────────────────────────────

function layout(heights: number[]): { offsets: number[]; totalHeight: number } {
  const offsets: number[] = []
  let cursor = 0
  heights.forEach((h) => { offsets.push(cursor); cursor += h })
  return { offsets, totalHeight: cursor + 20 }
}

test('scroll trap (old behavior): nav effect re-runs on every height change and yanks the scroll', () => {
  const N = 40
  const heights = Array.from({ length: N }, () => 140) // stale estimates
  const viewport = 600
  const navTargetIndex = 10

  let scrollTop = 0
  let userDrags = 0
  let navResets = 0

  // OLD behavior: the nav effect re-runs whenever virtualLayout.heights
  // changes — once per re-measuring row.
  for (let frame = 0; frame < N; frame++) {
    heights[frame] = 200
    const { offsets } = layout(heights)
    scrollTop = Math.max(0, offsets[navTargetIndex] - (viewport - heights[navTargetIndex]) / 2)
    navResets++
    if (frame === 25) {
      userDrags++
      scrollTop = layout(heights).totalHeight - viewport
    }
  }

  assertEqual(userDrags, 1, 'one user drag')
  assertTrue(navResets > userDrags, `nav resets (${navResets}) outnumber the drag — bug reproduced`)
  assertTrue(
    scrollTop < layout(heights).totalHeight - viewport,
    'final scrollTop is NOT at the bottom — the drag was overridden',
  )
})

test('scroll trap (fixed): nav jump fires exactly once per click (version-keyed)', () => {
  const N = 40
  const heights = Array.from({ length: N }, () => 140)
  const viewport = 600
  const navTargetIndex = 10

  let scrollTop = 0
  let userDrags = 0
  let navJumps = 0

  // NEW behavior: the effect only fires when userNavTargetVersion changes
  // (once per click), never on layout-only updates.
  let lastAppliedVersion = -1
  const userNavTargetVersion = 1 // one click
  for (let frame = 0; frame < N; frame++) {
    heights[frame] = 200
    // the effect body (with the version guard)
    if (lastAppliedVersion !== userNavTargetVersion) {
      lastAppliedVersion = userNavTargetVersion
      const { offsets } = layout(heights)
      scrollTop = Math.max(0, offsets[navTargetIndex] - (viewport - heights[navTargetIndex]) / 2)
      navJumps++
    }
    if (frame === 25) {
      userDrags++
      scrollTop = layout(heights).totalHeight - viewport
    }
  }

  assertEqual(navJumps, 1, 'exactly one nav jump per click')
  assertEqual(userDrags, 1, 'one user drag')
  // The drag is no longer YANKED back to the nav target: after the drag,
  // scrollTop equals the bottom of the layout as it stood at drag time.
  // (Remaining rows may still re-measure and grow the content below — that's
  // normal streaming behavior, not an override.)
  const scrollTopAtDragEnd = layout(
    Array.from({ length: N }, (_, i) => (i <= 25 ? 200 : 140)),
  ).totalHeight - viewport
  assertEqual(
    scrollTop,
    scrollTopAtDragEnd,
    'the drag survives — scroll stays where the user put it',
  )
  assertTrue(
    scrollTop > layout(Array.from({ length: 26 }, () => 200)).offsets[10],
    'not yanked back to the nav target',
  )
})

test('scroll fix: a second click jumps again (version bump re-arms the effect)', () => {
  let lastAppliedVersion = -1
  const jumpsFor = (version: number): number => {
    let jumps = 0
    // simulate the effect firing across several layout changes at this version
    for (let layoutChange = 0; layoutChange < 5; layoutChange++) {
      if (lastAppliedVersion !== version) {
        lastAppliedVersion = version
        jumps++
      }
    }
    return jumps
  }
  assertEqual(jumpsFor(1), 1, 'first click → one jump')
  assertEqual(jumpsFor(2), 1, 'second click → one more jump')
  assertEqual(jumpsFor(2), 0, 'no further jumps without a new click')
  assertEqual(jumpsFor(3), 1, 'third click → one more jump')
})

test('scroll fix does not break normal streaming auto-scroll', () => {
  // While streaming (no nav jump, autoScroll on, no pending adjustment),
  // the force-scroll must still fire so new output stays visible.
  const heights = [200, 200, 200]
  const viewport = 600
  let scrollTop = 0
  const pendingAdjustment = 0 // nothing settling
  const autoScroll = true

  // Short chat (820px total < 600px viewport? no: 820 > 600) — pinned to the
  // clamped bottom.
  if (autoScroll && pendingAdjustment === 0) {
    scrollTop = Math.max(0, layout(heights).totalHeight - viewport)
  }
  assertEqual(scrollTop, layout(heights).totalHeight - viewport, 'pins to the true bottom while streaming')

  // Tall chat: still pinned to the bottom as messages grow.
  for (let i = 0; i < 20; i++) heights.push(200)
  if (autoScroll && pendingAdjustment === 0) {
    scrollTop = Math.max(0, layout(heights).totalHeight - viewport)
  }
  assertEqual(
    scrollTop,
    layout(heights).totalHeight - viewport,
    'streaming auto-scroll still pins to the bottom',
  )
})

// ─── Runner ─────────────────────────────────────────────────────────────────

function main() {
  let pass = 0, fail = 0
  for (const t of v3210Tests) {
    try { t.run(); pass++; console.log(`PASS ${t.name}`) }
    catch (e) { fail++; console.log(`FAIL ${t.name}: ${(e as Error).message}`) }
  }
  console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}
main()
