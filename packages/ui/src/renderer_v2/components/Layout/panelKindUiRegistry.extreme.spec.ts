import { getPanelKindUiItem, PANEL_KIND_UI_ORDER, resolveDefaultRailClickIntent } from './panelKindUiRegistry'

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(`${message}. expected=${String(expected)} actual=${String(actual)}`)
  }
}

const runCase = (name: string, fn: () => void): void => {
  fn()
  console.log(`PASS ${name}`)
}

runCase('rail click opens panel only when owner tabs exist but no panel exists', () => {
  const intent = resolveDefaultRailClickIntent({
    panelCount: 0,
    ownerTabCount: 3
  })
  assertEqual(intent, 'open-panel-only', 'rail click should only open panel for existing tabs')
})

runCase('rail click creates tab when no panel and no owner tabs exist', () => {
  const intent = resolveDefaultRailClickIntent({
    panelCount: 0,
    ownerTabCount: 0
  })
  assertEqual(intent, 'create-new-tab', 'rail click should create first tab when inventory is empty')
})

runCase('rail click creates tab when panel already exists', () => {
  const intent = resolveDefaultRailClickIntent({
    panelCount: 2,
    ownerTabCount: 5
  })
  assertEqual(intent, 'create-new-tab', 'rail click should create tab when panel exists')
})

runCase('filesystem rail click always opens panel only', () => {
  const item = getPanelKindUiItem('filesystem')
  const intentNoTabs = item.resolveRailClickIntent({
    panelCount: 0,
    ownerTabCount: 0
  })
  const intentWithTabs = item.resolveRailClickIntent({
    panelCount: 2,
    ownerTabCount: 4
  })
  assertEqual(intentNoTabs, 'open-panel-only', 'filesystem rail should not create tabs when empty')
  assertEqual(intentWithTabs, 'open-panel-only', 'filesystem rail should not create tabs when tabs exist')
})

runCase('owner tab count reflects global inventory', () => {
  const mockStore = {
    chat: {
      sessions: [{ id: 'chat-a' }, { id: 'chat-b' }]
    },
    terminalTabs: [{ id: 'term-a' }],
    fileSystemTabs: []
  } as any
  assertEqual(getPanelKindUiItem('chat').getOwnerTabCount(mockStore), 2, 'chat owner count should use global inventory')
  assertEqual(getPanelKindUiItem('terminal').getOwnerTabCount(mockStore), 1, 'terminal owner count should use global inventory')
  assertEqual(getPanelKindUiItem('filesystem').getOwnerTabCount(mockStore), 0, 'filesystem owner count should use global inventory')
})

runCase('special file editor panel is hidden from rail', () => {
  const railKinds = PANEL_KIND_UI_ORDER as readonly string[]
  assertEqual(
    railKinds.includes('fileEditor'),
    false,
    'special panel kinds without rail entry should not be rendered in rail'
  )
})

console.log('All panel kind rail strategy extreme tests passed.')
