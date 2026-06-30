import {
  addSavedLayoutSlot,
  createSavedLayoutSnapshot,
  deleteSavedLayoutSlot,
  findSavedLayoutSlot,
  getFirstAvailableSavedLayoutSlotNumber,
  getSavedLayoutSlotId,
  normalizeSavedLayoutState,
  overwriteSavedLayoutSlot,
  type LayoutTree
} from './index'

const assertCondition = (condition: unknown, message: string): void => {
  if (!condition) {
    throw new Error(message)
  }
}

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(`${message}. expected=${String(expected)} actual=${String(actual)}`)
  }
}

const makeTree = (panelId: string, kind: 'chat' | 'terminal' = 'terminal'): LayoutTree => ({
  schemaVersion: 2,
  root: {
    type: 'panel',
    id: `node-${panelId}`,
    panel: {
      id: panelId,
      kind
    }
  },
  focusedPanelId: panelId
})

const runCase = (name: string, fn: () => void): void => {
  fn()
  console.log(`PASS ${name}`)
}

runCase('normalizes saved layout slots and canonical ids', () => {
  const tree = makeTree('panel-a')
  const snapshot = createSavedLayoutSnapshot(tree)

  const state = normalizeSavedLayoutState({
    savedLayouts: [
      {
        id: 'custom-id-ignored',
        slotNumber: 2,
        createdAt: 10,
        updatedAt: 20,
        snapshot
      }
    ],
    activeSavedLayoutId: getSavedLayoutSlotId(2)
  })

  assertEqual(state.slots.length, 1, 'one valid slot should remain')
  assertEqual(state.slots[0].id, 'layout-slot-2', 'slot id should be canonical')
  assertEqual(state.slots[0].slotNumber, 2, 'slot number should be preserved')
  assertEqual(state.activeSavedLayoutId, 'layout-slot-2', 'active slot id should be preserved')
})

runCase('drops malformed slots, duplicate slot numbers, and stale active slot ids', () => {
  const snapshot = createSavedLayoutSnapshot(makeTree('panel-a'))
  const state = normalizeSavedLayoutState({
    savedLayouts: [
      null,
      { slotNumber: 4, snapshot },
      { slotNumber: 1, snapshot },
      {
        slotNumber: 1,
        snapshot: createSavedLayoutSnapshot(makeTree('panel-b'))
      },
      { slotNumber: 2, snapshot: { v2: { not: 'a layout tree' } } },
      { slotNumber: 3, snapshot: {} }
    ],
    activeSavedLayoutId: 'layout-slot-3'
  })

  assertEqual(state.slots.length, 1, 'only one valid unique slot should remain')
  assertEqual(state.slots[0].id, 'layout-slot-1', 'first valid duplicate should win')
  assertEqual(state.activeSavedLayoutId, null, 'stale active slot id should be cleared')
})

runCase('adds saved layout slots into the first free stable slot number', () => {
  const first = addSavedLayoutSlot([], makeTree('panel-a'), 100)
  assertCondition(first.slot !== null, 'first save should create a slot')
  assertEqual(first.slot?.slotNumber, 1, 'first save should use slot 1')

  const thirdSeed = [
    ...first.slots,
    {
      id: getSavedLayoutSlotId(3),
      slotNumber: 3 as const,
      createdAt: 200,
      updatedAt: 200,
      snapshot: createSavedLayoutSnapshot(makeTree('panel-c'))
    }
  ]
  const second = addSavedLayoutSlot(thirdSeed, makeTree('panel-b'), 300)
  assertCondition(second.slot !== null, 'second save should fill the gap')
  assertEqual(second.slot?.slotNumber, 2, 'save should use first free slot number')
  assertEqual(second.slots.map((slot) => slot.slotNumber).join(','), '1,2,3', 'slots should be sorted')
})

runCase('refuses to add more than three saved layout slots', () => {
  let slots = addSavedLayoutSlot([], makeTree('panel-a'), 1).slots
  slots = addSavedLayoutSlot(slots, makeTree('panel-b'), 2).slots
  slots = addSavedLayoutSlot(slots, makeTree('panel-c'), 3).slots

  const saturated = addSavedLayoutSlot(slots, makeTree('panel-d'), 4)
  assertEqual(saturated.slot, null, 'fourth save should be rejected')
  assertEqual(saturated.slots.length, 3, 'slot list should stay capped at three')
  assertEqual(getFirstAvailableSavedLayoutSlotNumber(saturated.slots), null, 'no free slot should remain')
})

runCase('deletes a saved layout slot without renumbering remaining slots', () => {
  let slots = addSavedLayoutSlot([], makeTree('panel-a'), 1).slots
  slots = addSavedLayoutSlot(slots, makeTree('panel-b'), 2).slots
  slots = addSavedLayoutSlot(slots, makeTree('panel-c'), 3).slots

  const remaining = deleteSavedLayoutSlot(slots, getSavedLayoutSlotId(2))
  assertEqual(remaining.length, 2, 'one slot should be deleted')
  assertEqual(remaining.map((slot) => slot.slotNumber).join(','), '1,3', 'remaining slot numbers should stay stable')
  assertEqual(getFirstAvailableSavedLayoutSlotNumber(remaining), 2, 'deleted slot number should become reusable')
})

runCase('overwrites a saved layout slot without renumbering or resetting createdAt', () => {
  let slots = addSavedLayoutSlot([], makeTree('panel-a'), 100).slots
  slots = addSavedLayoutSlot(slots, makeTree('panel-b'), 200).slots

  const overwritten = overwriteSavedLayoutSlot(slots, getSavedLayoutSlotId(1), makeTree('panel-replaced'), 500)
  assertCondition(overwritten.slot !== null, 'existing slot should be overwritten')
  assertEqual(overwritten.slots.length, 2, 'overwrite should not add or delete slots')
  assertEqual(overwritten.slot?.slotNumber, 1, 'slot number should stay stable')
  assertEqual(overwritten.slot?.createdAt, 100, 'createdAt should be preserved')
  assertEqual(overwritten.slot?.updatedAt, 500, 'updatedAt should reflect the overwrite time')
  assertEqual(
    overwritten.slot?.snapshot.v2.focusedPanelId,
    'panel-replaced',
    'snapshot should be replaced with current layout'
  )

  const missing = overwriteSavedLayoutSlot(slots, 'missing-slot', makeTree('panel-missing'), 600)
  assertEqual(missing.slot, null, 'missing slot overwrite should fail closed')
  assertEqual(missing.slots.length, 2, 'missing slot overwrite should leave slots untouched')
})

runCase('findSavedLayoutSlot returns normalized snapshots', () => {
  const saved = addSavedLayoutSlot([], makeTree('panel-chat', 'chat'), 10)
  const slot = findSavedLayoutSlot(saved.slots, getSavedLayoutSlotId(1))
  assertCondition(slot !== null, 'saved slot should be found')
  assertEqual(slot?.snapshot.v2.root.type, 'panel', 'snapshot tree should be present')
  assertEqual(slot?.snapshot.panelOrder[0], 'chat', 'legacy projection should be derived')
})

runCase('legacy-only saved snapshots remain recoverable', () => {
  const state = normalizeSavedLayoutState({
    savedLayouts: [
      {
        slotNumber: 1,
        snapshot: {
          panelOrder: ['chat', 'terminal'],
          panelSizes: [30, 70]
        }
      }
    ]
  })

  assertEqual(state.slots.length, 1, 'legacy snapshot should be accepted')
  assertEqual(state.slots[0].snapshot.v2.root.type, 'split', 'legacy snapshot should become a v2 tree')
})

console.log('All saved layout extreme tests passed.')
