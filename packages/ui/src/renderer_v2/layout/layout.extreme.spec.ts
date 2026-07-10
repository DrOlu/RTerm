import {
  CHAT_PANEL_MIN_WIDTH_PX,
  MAX_LAYOUT_PANELS,
  MAX_LAYOUT_SPLIT_CHILDREN,
  buildLayoutTree,
  clampSplitSizesToChildMinSizePercentages,
  computeChildMinSizePercentages,
  determineDropDirection,
  getPanelMinHeightPx,
  getPanelMinWidthPx,
  getPanelCount,
  listPanels,
  movePanel,
  removePanel,
  setSplitSizes,
  splitPanel,
  validateLayoutTree,
  type LayoutPanelNode,
  type LayoutSplitNode,
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

const makePanel = (nodeId: string, panelId: string, kind: 'chat' | 'terminal'): LayoutPanelNode => ({
  type: 'panel',
  id: nodeId,
  panel: {
    id: panelId,
    kind
  }
})

const makeSplit = (
  nodeId: string,
  direction: 'horizontal' | 'vertical',
  children: LayoutSplitNode['children'],
  sizes: number[]
): LayoutSplitNode => ({
  type: 'split',
  id: nodeId,
  direction,
  children,
  sizes
})

const runCase = (name: string, fn: () => void): void => {
  fn()
  console.log(`PASS ${name}`)
}

runCase('splitPanel inserts a new panel and focuses it', () => {
  const initial: LayoutTree = {
    schemaVersion: 2,
    root: makePanel('node-a', 'panel-a', 'chat'),
    focusedPanelId: 'panel-a'
  }

  const next = splitPanel(initial, 'panel-a', 'terminal', 'horizontal', 'after')
  assertEqual(getPanelCount(next), 2, 'splitPanel should increase panel count')
  assertEqual(next.root.type, 'split', 'splitPanel should create split root')
  if (next.root.type !== 'split') return
  assertEqual(next.root.direction, 'horizontal', 'splitPanel should preserve requested direction')
  const ids = listPanels(next).map((panel) => panel.panel.id)
  assertCondition(ids.includes('panel-a'), 'original panel should remain in tree')
  const insertedPanelId = ids.find((id) => id !== 'panel-a')
  assertCondition(Boolean(insertedPanelId), 'splitPanel should insert a new panel id')
  assertEqual(next.focusedPanelId, insertedPanelId, 'splitPanel should focus inserted panel')
})

runCase('movePanel center swaps panel payloads', () => {
  const initial: LayoutTree = {
    schemaVersion: 2,
    root: makeSplit(
      'root',
      'horizontal',
      [makePanel('node-a', 'panel-a', 'chat'), makePanel('node-b', 'panel-b', 'terminal')],
      [50, 50]
    )
  }

  const next = movePanel(initial, 'panel-a', 'panel-b', 'center')
  assertEqual(next.root.type, 'split', 'center move should keep split root')
  if (next.root.type !== 'split') return
  const [left, right] = next.root.children
  assertEqual(left.type, 'panel', 'left child should remain panel')
  assertEqual(right.type, 'panel', 'right child should remain panel')
  if (left.type !== 'panel' || right.type !== 'panel') return
  assertEqual(left.panel.kind, 'terminal', 'center move should swap panel payloads')
  assertEqual(right.panel.kind, 'chat', 'center move should swap panel payloads')
})

runCase('removePanel never removes the final panel', () => {
  const initial: LayoutTree = {
    schemaVersion: 2,
    root: makePanel('node-only', 'panel-only', 'terminal'),
    focusedPanelId: 'panel-only'
  }

  const next = removePanel(initial, 'panel-only')
  assertCondition(next === initial, 'removePanel should no-op for final panel')
  assertEqual(getPanelCount(next), 1, 'final panel must remain')
})

runCase('fresh default layout starts with list panel, chat, then terminal', () => {
  const tree = buildLayoutTree(undefined)
  assertEqual(tree.root.type, 'split', 'fresh default layout should use a horizontal split')
  if (tree.root.type !== 'split') return

  assertEqual(tree.root.direction, 'horizontal', 'fresh default layout should be horizontal')
  assertEqual(
    JSON.stringify(listPanels(tree).map((panel) => panel.panel.kind)),
    JSON.stringify(['listPanel', 'chat', 'terminal']),
    'fresh default panel order should match the global tab directory workflow'
  )
  assertEqual(
    JSON.stringify(tree.root.sizes.map((size) => Math.round(size))),
    JSON.stringify([18, 41, 41]),
    'fresh default layout should keep the list panel visually narrow'
  )
})

runCase('legacy explicit panel order does not gain a list panel implicitly', () => {
  const tree = buildLayoutTree({
    panelOrder: ['chat', 'terminal'],
    panelSizes: [30, 70]
  })
  assertEqual(
    JSON.stringify(listPanels(tree).map((panel) => panel.panel.kind)),
    JSON.stringify(['chat', 'terminal']),
    'legacy explicit layouts should preserve their panel order'
  )
})

runCase('setSplitSizes normalizes arbitrary size vectors', () => {
  const initial: LayoutTree = {
    schemaVersion: 2,
    root: makeSplit(
      'root',
      'horizontal',
      [
        makePanel('node-a', 'panel-a', 'terminal'),
        makePanel('node-b', 'panel-b', 'terminal'),
        makePanel('node-c', 'panel-c', 'chat')
      ],
      [10, 10, 80]
    )
  }

  const next = setSplitSizes(initial, 'root', [20, 30, 0])
  assertEqual(next.root.type, 'split', 'setSplitSizes should keep split node')
  if (next.root.type !== 'split') return
  assertEqual(next.root.sizes.length, 3, 'sizes count should match children')
  const total = next.root.sizes.reduce((sum, size) => sum + size, 0)
  assertCondition(Math.abs(total - 100) < 0.001, 'normalized sizes should sum to ~100')
  assertCondition(next.root.sizes.every((size) => Number.isFinite(size) && size >= 0), 'sizes should be finite')
  assertCondition(next.root.sizes[0] > 0 && next.root.sizes[1] > 0, 'positive sizes should stay positive')
})

runCase('validateLayoutTree enforces chat minimum rows in tall viewports', () => {
  const tree: LayoutTree = {
    schemaVersion: 2,
    root: makeSplit(
      'root',
      'vertical',
      [makePanel('chat-node', 'chat-panel', 'chat'), makePanel('term-node', 'term-panel', 'terminal')],
      [5, 95]
    )
  }

  const result = validateLayoutTree(tree, { width: 1600, height: 1200 })
  assertEqual(result.valid, false, 'undersized chat panel must be rejected')
  assertCondition(Boolean(result.reason?.startsWith('chat-height-limit:')), 'chat height limit reason should be reported')
})

runCase('computeChildMinSizePercentages reflects chat minimum height requirement', () => {
  const split = makeSplit(
    'root',
    'vertical',
    [makePanel('chat-node', 'chat-panel', 'chat'), makePanel('term-node', 'term-panel', 'terminal')],
    [50, 50]
  )

  const percentages = computeChildMinSizePercentages(
    split,
    { left: 0, top: 0, width: 1200, height: 1200 },
    1200
  )
  const expectedChatMinPx = getPanelMinHeightPx('chat', 1200)
  assertCondition(Math.abs(percentages[0] - (expectedChatMinPx / 1200) * 100) < 0.001, 'chat min percentage should be exact')
  assertCondition(percentages[0] > percentages[1], 'chat min percentage should exceed terminal in this viewport')
})

runCase('clampSplitSizesToChildMinSizePercentages keeps resize sizes above child minimums', () => {
  const sizes = clampSplitSizesToChildMinSizePercentages([1, 99], [33.333333, 7.5])
  const total = sizes.reduce((sum, size) => sum + size, 0)
  assertCondition(Math.abs(total - 100) < 0.001, 'clamped sizes should still sum to ~100')
  assertCondition(sizes[0] >= 33.333333 - 0.001, 'first child should be clamped to its minimum')
  assertCondition(sizes[1] <= 66.666667 + 0.001, 'second child should give up overflow space')
})

runCase('validateLayoutTree enforces per-panel minimum width', () => {
  const tree: LayoutTree = {
    schemaVersion: 2,
    root: makeSplit(
      'root',
      'horizontal',
      [makePanel('term-node-a', 'term-panel-a', 'terminal'), makePanel('term-node-b', 'term-panel-b', 'terminal')],
      [50, 50]
    )
  }

  const result = validateLayoutTree(tree, {
    width: getPanelMinWidthPx('terminal') * 2 - 20,
    height: 900
  })
  assertEqual(result.valid, false, 'terminal panels narrower than the minimum width must be rejected')
  assertCondition(Boolean(result.reason?.startsWith('panel-width-limit:')), 'width limit reason should be reported')
})

runCase('panel minimum sizes remain per-kind', () => {
  assertEqual(CHAT_PANEL_MIN_WIDTH_PX, 292, 'chat composer footer minimum width should stay explicit')
  assertEqual(getPanelMinWidthPx('chat'), CHAT_PANEL_MIN_WIDTH_PX, 'chat min width should fit composer footer controls')
  assertEqual(getPanelMinWidthPx('terminal'), 160, 'terminal min width should use per-kind reduced threshold')
  assertEqual(getPanelMinWidthPx('monitor'), 170, 'monitor min width should use per-kind reduced threshold')
  assertEqual(getPanelMinHeightPx('terminal', 900), 90, 'terminal min height should use per-kind reduced threshold')
  assertEqual(getPanelMinHeightPx('monitor', 900), 120, 'monitor min height should use per-kind reduced threshold')
})

runCase('determineDropDirection classifies center and edges', () => {
  const rect = { left: 100, top: 100, width: 300, height: 200 }
  assertEqual(determineDropDirection(rect, 250, 200), 'center', 'center classification mismatch')
  assertEqual(determineDropDirection(rect, 110, 200), 'left', 'left classification mismatch')
  assertEqual(determineDropDirection(rect, 390, 200), 'right', 'right classification mismatch')
  assertEqual(determineDropDirection(rect, 250, 110), 'top', 'top classification mismatch')
  assertEqual(determineDropDirection(rect, 250, 290), 'bottom', 'bottom classification mismatch')
})

runCase('splitPanel stops at MAX_LAYOUT_PANELS', () => {
  let tree: LayoutTree = {
    schemaVersion: 2,
    root: makePanel('seed-node', 'seed-panel', 'terminal')
  }

  while (getPanelCount(tree) < MAX_LAYOUT_PANELS) {
    const targetId = listPanels(tree)[0].panel.id
    tree = splitPanel(tree, targetId, 'terminal', 'horizontal', 'after')
  }

  const targetId = listPanels(tree)[0].panel.id
  const saturated = splitPanel(tree, targetId, 'chat', 'vertical', 'after')
  assertCondition(saturated === tree, 'splitPanel should no-op at max panel limit')
  assertEqual(getPanelCount(saturated), MAX_LAYOUT_PANELS, 'max panel limit must be respected')
})

runCase('splitPanel keeps per-split child count bounded by dynamic wrapping', () => {
  let tree: LayoutTree = {
    schemaVersion: 2,
    root: makePanel('seed-node', 'seed-panel', 'terminal')
  }

  for (let i = 0; i < 14; i += 1) {
    const targetId = listPanels(tree)[0].panel.id
    tree = splitPanel(tree, targetId, 'terminal', 'horizontal', 'after')
  }

  const stack = [tree.root]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current || current.type !== 'split') continue
    assertCondition(
      current.children.length <= MAX_LAYOUT_SPLIT_CHILDREN,
      'split node children should never exceed configured limit'
    )
    current.children.forEach((child) => stack.push(child))
  }
})

console.log('All layout extreme tests passed.')
