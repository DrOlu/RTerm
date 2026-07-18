import assert from 'node:assert'

/**
 * broadcastStore.extreme.spec — verifies the broadcast-input store lifecycle
 * (membership, enable/pause semantics, fan-out targeting, pruning) without
 * rendering React. window.gyshell is stubbed to capture writeBroadcast calls.
 */

// Stub the preload bridge BEFORE importing the store.
const broadcastCalls: Array<{ ids: string[]; data: string }> = []
;(globalThis as any).window = {
  gyshell: {
    terminal: {
      writeBroadcast: (ids: string[], data: string) => {
        broadcastCalls.push({ ids: [...ids], data })
        return Promise.resolve(ids)
      },
    },
  },
}

const { broadcastStore } = await import('./BroadcastStore')

let pass = 0, fail = 0
function test(n: string, r: () => void) {
  try { r(); pass++; console.log(`PASS ${n}`) }
  catch (e: any) { fail++; console.log(`FAIL ${n}: ${e?.message ?? e}`) }
}

function reset() {
  broadcastStore.clear()
  broadcastCalls.length = 0
}

test('broadcast is OFF by default and membership is empty', () => {
  reset()
  assert.strictEqual(broadcastStore.enabled, false)
  assert.strictEqual(broadcastStore.memberIds.size, 0)
  assert.deepStrictEqual(broadcastStore.activeMemberIds, [])
})

test('fanOut does nothing when broadcast is disabled', () => {
  reset()
  broadcastStore.addMember('t1')
  broadcastStore.addMember('t2')
  const targets = broadcastStore.fanOut('t1', 'ls\n')
  assert.deepStrictEqual(targets, [])
  assert.strictEqual(broadcastCalls.length, 0)
})

test('fanOut sends to other members but not the originator (no double-send)', () => {
  reset()
  broadcastStore.addMember('t1')
  broadcastStore.addMember('t2')
  broadcastStore.addMember('t3')
  broadcastStore.setEnabled(true)
  const targets = broadcastStore.fanOut('t1', 'show run\n')
  assert.deepStrictEqual(targets.sort(), ['t2', 't3'])
  assert.strictEqual(broadcastCalls.length, 1)
  assert.deepStrictEqual(broadcastCalls[0].ids.sort(), ['t2', 't3'])
  assert.strictEqual(broadcastCalls[0].data, 'show run\n')
})

test('typing into a non-member terminal never leaks into the group', () => {
  reset()
  broadcastStore.addMember('t1')
  broadcastStore.addMember('t2')
  broadcastStore.setEnabled(true)
  const targets = broadcastStore.fanOut('outsider', 'secret\n')
  assert.deepStrictEqual(targets, [])
  assert.strictEqual(broadcastCalls.length, 0)
})

test('paused members are skipped during fan-out', () => {
  reset()
  broadcastStore.addMember('t1')
  broadcastStore.addMember('t2')
  broadcastStore.addMember('t3')
  broadcastStore.setEnabled(true)
  broadcastStore.setPaused('t3', true)
  const targets = broadcastStore.fanOut('t1', 'x')
  assert.deepStrictEqual(targets, ['t2'])
  assert.deepStrictEqual(broadcastCalls[0].ids, ['t2'])
})

test('togglePaused flips pause state and removeMember clears it', () => {
  reset()
  broadcastStore.addMember('t1')
  broadcastStore.togglePaused('t1')
  assert.ok(broadcastStore.pausedIds.has('t1'))
  broadcastStore.togglePaused('t1')
  assert.ok(!broadcastStore.pausedIds.has('t1'))
  broadcastStore.setPaused('t1', true)
  broadcastStore.removeMember('t1')
  assert.ok(!broadcastStore.pausedIds.has('t1'), 'pause state cleared on remove')
})

test('toggleMember adds then removes', () => {
  reset()
  broadcastStore.toggleMember('t9')
  assert.ok(broadcastStore.isMember('t9'))
  broadcastStore.toggleMember('t9')
  assert.ok(!broadcastStore.isMember('t9'))
})

test('prune drops members that no longer exist', () => {
  reset()
  broadcastStore.addMember('live1')
  broadcastStore.addMember('dead1')
  broadcastStore.addMember('dead2')
  broadcastStore.setPaused('dead1', true)
  broadcastStore.prune(new Set(['live1']))
  assert.deepStrictEqual([...broadcastStore.memberIds], ['live1'])
  assert.strictEqual(broadcastStore.pausedIds.size, 0)
})

test('a lone member gets no fan-out (nothing to target)', () => {
  reset()
  broadcastStore.addMember('t1')
  broadcastStore.setEnabled(true)
  const targets = broadcastStore.fanOut('t1', 'x')
  assert.deepStrictEqual(targets, [])
  assert.strictEqual(broadcastCalls.length, 0)
})

test('clear resets everything', () => {
  reset()
  broadcastStore.addMember('t1')
  broadcastStore.setEnabled(true)
  broadcastStore.setPaused('t1', true)
  broadcastStore.clear()
  assert.strictEqual(broadcastStore.enabled, false)
  assert.strictEqual(broadcastStore.memberIds.size, 0)
  assert.strictEqual(broadcastStore.pausedIds.size, 0)
})

console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
