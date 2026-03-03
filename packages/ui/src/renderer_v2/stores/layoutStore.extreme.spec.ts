import { LayoutStore } from './LayoutStore'
import type { LayoutTree } from '../layout'

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

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

interface SettingsSetPayload {
  layout?: {
    panelOrder?: string[]
    panelSizes?: number[]
    v2?: unknown
  }
}

interface SettingsSetSpy {
  calls: SettingsSetPayload[]
}

const installWindowMock = (spy: SettingsSetSpy): void => {
  ;(globalThis as unknown as { window: unknown }).window = {
    gyshell: {
      settings: {
        set: async (payload: SettingsSetPayload) => {
          spy.calls.push(payload)
        }
      }
    }
  }
}

const createStore = (options?: {
  settings?: { layout?: unknown }
  terminalIds?: string[]
  chatIds?: string[]
  terminalInventoryHydrated?: boolean
  chatInventoryHydrated?: boolean
  activeTerminalId?: string | null
}): LayoutStore => {
  const terminalIds = options?.terminalIds || ['term-1']
  const chatIds = options?.chatIds || ['chat-1']
  const activeTerminalId = options?.activeTerminalId === undefined ? (terminalIds[0] || null) : options.activeTerminalId
  const appStore = {
    settings: options?.settings ? (options.settings as any) : null,
    terminalTabs: terminalIds.map((id) => ({
      id,
      title: id,
      config: {
        type: 'local',
        id,
        title: id,
        cols: 80,
        rows: 24
      }
    })),
    terminalTabsHydrated: options?.terminalInventoryHydrated ?? true,
    activeTerminalId,
    setActiveTerminal(id: string) {
      this.activeTerminalId = id
    },
    onPanelRemoved(_kind: string) {},
    chat: {
      sessionInventoryHydrated: options?.chatInventoryHydrated ?? true,
      sessions: chatIds.map((id) => ({
        id,
        title: id,
        messagesById: new Map(),
        messageIds: [],
        isThinking: false,
        isSessionBusy: false,
        lockedProfileId: null
      })),
      activeSessionId: chatIds[0] || null,
      setActiveSession(id: string) {
        this.activeSessionId = id
      }
    }
  }
  return new LayoutStore(appStore as any)
}

const runCase = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
  await fn()
  console.log(`PASS ${name}`)
}

const run = async (): Promise<void> => {
  await runCase('bootstrap loads v2 tree, sets focus, and assigns chat bindings', async () => {
    const persistedTree: LayoutTree = {
      schemaVersion: 2,
      root: {
        type: 'panel',
        id: 'node-chat',
        panel: {
          id: 'panel-chat',
          kind: 'chat'
        }
      }
    }
    const store = createStore({
      settings: {
        layout: {
          v2: persistedTree
        }
      },
      chatIds: ['chat-a', 'chat-b'],
      terminalIds: ['term-a']
    })
    store.bootstrap()

    assertEqual(store.panelCount, 1, 'bootstrap should restore panel count')
    assertEqual(store.tree.root.type, 'panel', 'bootstrap should preserve persisted root')
    assertEqual(store.tree.focusedPanelId, 'panel-chat', 'bootstrap should set focused panel when missing')
    assertCondition(
      JSON.stringify(store.getPanelTabIds('panel-chat')) === JSON.stringify(['chat-a', 'chat-b']),
      'chat tabs should be assigned to the only chat panel on bootstrap'
    )
  })

  await runCase('bootstrap does not prune terminal panels before terminal inventory is hydrated', async () => {
    const persistedTree: LayoutTree = {
      schemaVersion: 2,
      root: {
        type: 'split',
        id: 'root',
        direction: 'horizontal',
        children: [
          {
            type: 'panel',
            id: 'node-chat',
            panel: { id: 'panel-chat', kind: 'chat' }
          },
          {
            type: 'split',
            id: 'node-term-root',
            direction: 'vertical',
            children: [
              {
                type: 'panel',
                id: 'node-term-a',
                panel: { id: 'panel-term-a', kind: 'terminal' }
              },
              {
                type: 'panel',
                id: 'node-term-b',
                panel: { id: 'panel-term-b', kind: 'terminal' }
              }
            ],
            sizes: [50, 50]
          }
        ],
        sizes: [35, 65]
      },
      managerPanels: {
        chat: 'panel-chat',
        terminal: 'panel-term-a'
      },
      panelTabs: {
        'panel-chat': { tabIds: ['chat-1'], activeTabId: 'chat-1' },
        'panel-term-a': { tabIds: ['term-a'], activeTabId: 'term-a' },
        'panel-term-b': { tabIds: ['term-b'], activeTabId: 'term-b' }
      }
    }

    const store = createStore({
      settings: {
        layout: {
          v2: persistedTree
        }
      },
      terminalIds: [],
      chatIds: ['chat-1'],
      terminalInventoryHydrated: false
    })

    store.bootstrap()
    const terminalPanels = store.panelNodes.filter((node) => node.panel.kind === 'terminal')
    assertEqual(terminalPanels.length, 2, 'terminal panels must be preserved before inventory hydration')
    assertEqual(
      JSON.stringify(store.getPanelTabIds('panel-term-b')),
      JSON.stringify(['term-b']),
      'persisted tab bindings should be preserved before inventory hydration'
    )

    const internal = store as any
    internal.appStore.terminalTabs = [{ id: 'term-a' }, { id: 'term-b' }]
    internal.appStore.terminalTabsHydrated = true
    store.syncPanelBindings({ persist: false })
    const hydratedTerminalPanels = store.panelNodes.filter((node) => node.panel.kind === 'terminal')
    assertEqual(hydratedTerminalPanels.length, 2, 'terminal panels should remain after hydration sync')
  })

  await runCase('missing restored terminal tabs keep placeholder panel when pinned', async () => {
    const persistedTree: LayoutTree = {
      schemaVersion: 2,
      root: {
        type: 'split',
        id: 'root',
        direction: 'horizontal',
        children: [
          { type: 'panel', id: 'node-chat', panel: { id: 'panel-chat', kind: 'chat' } },
          { type: 'panel', id: 'node-term-a', panel: { id: 'panel-term-a', kind: 'terminal' } },
          { type: 'panel', id: 'node-term-b', panel: { id: 'panel-term-b', kind: 'terminal' } }
        ],
        sizes: [34, 33, 33]
      },
      panelTabs: {
        'panel-chat': { tabIds: ['chat-1'], activeTabId: 'chat-1' },
        'panel-term-a': { tabIds: ['term-a'], activeTabId: 'term-a' },
        'panel-term-b': { tabIds: ['term-missing'], activeTabId: 'term-missing' }
      }
    }

    const store = createStore({
      settings: {
        layout: {
          v2: persistedTree
        }
      },
      terminalIds: [],
      chatIds: ['chat-1'],
      terminalInventoryHydrated: false
    })

    store.bootstrap()
    const unresolvedPanelIds = store.getPanelsWithMissingTabBindings('terminal', ['term-a'])
    assertEqual(
      JSON.stringify(unresolvedPanelIds),
      JSON.stringify(['panel-term-b']),
      'missing terminal ids should map to their original panel'
    )
    store.pinPanelsAsRestorePlaceholder(unresolvedPanelIds)

    const internal = store as any
    internal.appStore.terminalTabs = [{ id: 'term-a' }]
    internal.appStore.activeTerminalId = 'term-a'
    internal.appStore.terminalTabsHydrated = true
    store.syncPanelBindings({ persist: false })

    const terminalPanels = store.panelNodes.filter((node) => node.panel.kind === 'terminal')
    assertEqual(terminalPanels.length, 2, 'pinned placeholder panel should not be auto-pruned')
    assertEqual(
      JSON.stringify(store.getPanelTabIds('panel-term-b')),
      JSON.stringify([]),
      'placeholder panel should become empty after unresolved tab ids are removed'
    )
  })

  await runCase('syncPanelBindings aligns panel active tab with global active terminal', async () => {
    const store = createStore({
      terminalIds: ['term-a', 'term-b'],
      activeTerminalId: 'term-b',
      terminalInventoryHydrated: true
    })
    store.bootstrap()

    const primaryPanelId = store.getPrimaryPanelId('terminal')
    assertCondition(Boolean(primaryPanelId), 'terminal primary panel should exist')
    assertEqual(
      store.getPanelActiveTabId(primaryPanelId!),
      'term-b',
      'primary panel active tab should align to global active terminal'
    )
  })

  await runCase('splitPanel keeps newly created empty panel instead of pruning immediately', async () => {
    const store = createStore({
      terminalIds: ['term-a'],
      chatIds: ['chat-a'],
      terminalInventoryHydrated: true
    })
    store.bootstrap()

    const terminalPrimaryId = store.getPrimaryPanelId('terminal')
    assertCondition(Boolean(terminalPrimaryId), 'terminal primary panel should exist before split')
    store.splitPanel(terminalPrimaryId!, 'terminal', 'horizontal', 'after')

    const terminalPanels = store.panelNodes.filter((node) => node.panel.kind === 'terminal')
    assertEqual(terminalPanels.length, 2, 'split should retain two terminal panels')
    assertEqual(store.panelCount, 3, 'split should increase total panel count including chat panel')

    const newPanelId = store.tree.focusedPanelId
    assertCondition(Boolean(newPanelId), 'new split panel should become focused')
    assertEqual(
      store.getPanelTabIds(newPanelId!).length,
      0,
      'new split panel can be empty without being auto-pruned in same update'
    )
  })

  await runCase('file editor special panel stays without tabs and remains singleton', async () => {
    const store = createStore({
      terminalIds: ['term-a'],
      chatIds: ['chat-a'],
      terminalInventoryHydrated: true
    })
    store.bootstrap()
    store.setViewport(1400, 900)

    const terminalPrimaryId = store.getPrimaryPanelId('terminal')
    assertCondition(Boolean(terminalPrimaryId), 'terminal primary panel should exist before creating file editor panel')
    store.splitPanel(terminalPrimaryId!, 'fileEditor', 'horizontal', 'after')

    let fileEditorPanels = store.panelNodes.filter((node) => node.panel.kind === 'fileEditor')
    assertEqual(fileEditorPanels.length, 1, 'file editor panel should be created from split')
    assertEqual(
      store.getPanelTabIds(fileEditorPanels[0].panel.id).length,
      0,
      'file editor panel should not maintain tab bindings'
    )

    store.splitPanel(fileEditorPanels[0].panel.id, 'fileEditor', 'horizontal', 'after')
    fileEditorPanels = store.panelNodes.filter((node) => node.panel.kind === 'fileEditor')
    assertEqual(fileEditorPanels.length, 1, 'file editor panel should remain singleton after repeated creation attempts')
  })

  await runCase('chat bindings are preserved while chat inventory is not hydrated', async () => {
    const persistedTree: LayoutTree = {
      schemaVersion: 2,
      root: {
        type: 'split',
        id: 'root-chat',
        direction: 'horizontal',
        children: [
          { type: 'panel', id: 'node-chat-a', panel: { id: 'panel-chat-a', kind: 'chat' } },
          { type: 'panel', id: 'node-chat-b', panel: { id: 'panel-chat-b', kind: 'chat' } },
          { type: 'panel', id: 'node-terminal', panel: { id: 'panel-terminal', kind: 'terminal' } }
        ],
        sizes: [33, 33, 34]
      },
      managerPanels: {
        chat: 'panel-chat-a',
        terminal: 'panel-terminal'
      },
      panelTabs: {
        'panel-chat-a': { tabIds: ['old-chat-1'], activeTabId: 'old-chat-1' },
        'panel-chat-b': { tabIds: ['old-chat-2'], activeTabId: 'old-chat-2' },
        'panel-terminal': { tabIds: ['term-a'], activeTabId: 'term-a' }
      }
    }

    const store = createStore({
      settings: { layout: { v2: persistedTree } },
      terminalIds: ['term-a'],
      chatIds: ['new-default-chat'],
      terminalInventoryHydrated: true,
      chatInventoryHydrated: false
    })
    store.bootstrap()

    const chatPanelsBeforeHydration = store.panelNodes.filter((node) => node.panel.kind === 'chat')
    assertEqual(chatPanelsBeforeHydration.length, 2, 'chat panels must not be pruned before chat inventory hydration')
    assertEqual(
      JSON.stringify(store.getPanelTabIds('panel-chat-b')),
      JSON.stringify(['old-chat-2']),
      'persisted chat tab bindings should stay intact before hydration'
    )

    const internal = store as any
    internal.appStore.chat.sessions = [
      {
        id: 'old-chat-1',
        title: 'old-chat-1',
        messagesById: new Map(),
        messageIds: [],
        isThinking: false,
        isSessionBusy: false,
        lockedProfileId: null
      },
      {
        id: 'old-chat-2',
        title: 'old-chat-2',
        messagesById: new Map(),
        messageIds: [],
        isThinking: false,
        isSessionBusy: false,
        lockedProfileId: null
      }
    ]
    internal.appStore.chat.activeSessionId = 'old-chat-1'
    internal.appStore.chat.sessionInventoryHydrated = true
    store.syncPanelBindings({ persist: false })

    const chatPanelsAfterHydration = store.panelNodes.filter((node) => node.panel.kind === 'chat')
    assertEqual(chatPanelsAfterHydration.length, 2, 'hydrated inventory should keep the two persisted chat panels')
    assertEqual(store.getPanelActiveTabId('panel-chat-a'), 'old-chat-1', 'chat panel active tab should align after hydration')
  })

  await runCase('splitPanel persists v2 tree and legacy projection', async () => {
    const spy: SettingsSetSpy = { calls: [] }
    installWindowMock(spy)

    const store = createStore()
    store.bootstrap()
    store.setViewport(1440, 900)
    const sourcePanelId = store.panelNodes[0]?.panel.id
    assertCondition(Boolean(sourcePanelId), 'source panel should exist')

    store.splitPanel(sourcePanelId!, 'terminal', 'horizontal', 'after')
    await sleep(220)

    assertCondition(spy.calls.length > 0, 'settings.set should be called after split')
    const lastPayload = spy.calls[spy.calls.length - 1]
    assertCondition(Boolean(lastPayload.layout?.v2), 'persisted payload should contain layout.v2')
    assertCondition(Array.isArray(lastPayload.layout?.panelOrder), 'persisted payload should include legacy panelOrder')
    assertCondition(Array.isArray(lastPayload.layout?.panelSizes), 'persisted payload should include legacy panelSizes')
  })

  await runCase('setSplitSizes rejects invalid chat height changes', async () => {
    const spy: SettingsSetSpy = { calls: [] }
    installWindowMock(spy)

    const store = createStore({
      settings: {
        layout: {
          v2: {
            schemaVersion: 2,
            root: {
              type: 'panel',
              id: 'node-terminal',
              panel: {
                id: 'panel-terminal',
                kind: 'terminal'
              }
            }
          }
        }
      }
    })

    store.bootstrap()
    store.setViewport(1200, 1200)
    store.splitPanel('panel-terminal', 'chat', 'vertical', 'before')
    const root = store.tree.root
    assertEqual(root.type, 'split', 'split should create vertical root')
    if (root.type !== 'split') return

    const before = root.sizes.join(',')
    store.setSplitSizes(root.id, [1, 99])
    const afterRoot = store.tree.root
    assertEqual(afterRoot.type, 'split', 'root should remain split')
    if (afterRoot.type !== 'split') return
    const after = afterRoot.sizes.join(',')

    assertEqual(after, before, 'invalid chat-min-height resize must be rejected')
  })

  await runCase('commitDragging center swaps panel payloads', async () => {
    const spy: SettingsSetSpy = { calls: [] }
    installWindowMock(spy)

    const store = createStore({
      settings: {
        layout: {
          v2: {
            schemaVersion: 2,
            root: {
              type: 'split',
              id: 'root',
              direction: 'horizontal',
              children: [
                {
                  type: 'panel',
                  id: 'node-chat',
                  panel: { id: 'panel-chat', kind: 'chat' }
                },
                {
                  type: 'panel',
                  id: 'node-terminal',
                  panel: { id: 'panel-terminal', kind: 'terminal' }
                }
              ],
              sizes: [50, 50]
            }
          }
        }
      }
    })

    store.bootstrap()
    store.setViewport(1200, 700)
    store.startPanelDragging('panel-chat', 100, 100)
    store.setDropTarget('panel-terminal', 'center')
    store.commitDragging()

    const panelKinds = store.panelNodes.map((node) => node.panel.kind)
    assertEqual(panelKinds[0], 'terminal', 'center drop should swap first panel kind')
    assertEqual(panelKinds[1], 'chat', 'center drop should swap second panel kind')
  })

  await runCase('tab drag to edge splits a new panel and moves only that tab', async () => {
    const store = createStore({
      terminalIds: ['term-a', 'term-b'],
      chatIds: ['chat-a']
    })
    store.bootstrap()
    store.setViewport(1400, 900)

    const terminalPanelId = store.panelNodes.find((node) => node.panel.kind === 'terminal')?.panel.id
    assertCondition(Boolean(terminalPanelId), 'terminal panel should exist')
    assertEqual(store.panelCount, 2, 'default layout should contain two panels')

    store.startTabDragging(
      {
        tabId: 'term-b',
        kind: 'terminal',
        sourcePanelId: terminalPanelId!
      },
      200,
      200
    )
    store.setDropTarget(terminalPanelId!, 'right')
    store.commitDragging()

    assertEqual(store.panelCount, 3, 'tab edge drop should create a third panel')
    const panelsWithTermB = store.panelNodes.filter((node) => store.getPanelTabIds(node.panel.id).includes('term-b'))
    assertEqual(panelsWithTermB.length, 1, 'dragged tab should belong to exactly one panel')
    assertCondition(
      panelsWithTermB[0].panel.id !== terminalPanelId,
      'dragged tab should be moved out of source panel into new panel'
    )
    assertCondition(
      !store.getPanelTabIds(terminalPanelId!).includes('term-b'),
      'source panel should no longer contain dragged tab'
    )
  })

  await runCase('tab center move prunes source panel immediately when it becomes empty', async () => {
    const store = createStore({
      terminalIds: ['term-a', 'term-b'],
      chatIds: ['chat-a']
    })
    store.bootstrap()
    store.setViewport(1400, 900)

    const primaryPanelId = store.getPrimaryPanelId('terminal')
    assertCondition(Boolean(primaryPanelId), 'terminal primary panel should exist')

    store.startTabDragging(
      {
        tabId: 'term-b',
        kind: 'terminal',
        sourcePanelId: primaryPanelId!
      },
      220,
      220
    )
    store.setDropTarget(primaryPanelId!, 'right')
    store.commitDragging()
    assertEqual(store.panelCount, 3, 'should create an extra terminal panel after edge split')

    const detachedPanelId = store
      .panelNodes
      .filter((node) => node.panel.kind === 'terminal')
      .map((node) => node.panel.id)
      .find((id) => id !== primaryPanelId)
    assertCondition(Boolean(detachedPanelId), 'detached terminal panel should exist')
    assertEqual(
      JSON.stringify(store.getPanelTabIds(detachedPanelId!)),
      JSON.stringify(['term-b']),
      'detached panel should own term-b before center merge'
    )

    store.startTabDragging(
      {
        tabId: 'term-b',
        kind: 'terminal',
        sourcePanelId: detachedPanelId!
      },
      320,
      320
    )
    store.setDropTarget(primaryPanelId!, 'center')
    store.commitDragging()

    assertEqual(store.panelCount, 2, 'empty source panel should be pruned immediately after center move')
    const terminalPanels = store.panelNodes.filter((node) => node.panel.kind === 'terminal')
    assertEqual(terminalPanels.length, 1, 'only one terminal panel should remain after prune')
    assertEqual(
      JSON.stringify(store.getPanelTabIds(terminalPanels[0].panel.id).sort()),
      JSON.stringify(['term-a', 'term-b']),
      'remaining terminal panel should include both tabs'
    )
  })

  await runCase('syncPanelBindings auto-removes empty panels', async () => {
    const store = createStore({
      terminalIds: ['term-a', 'term-b'],
      chatIds: ['chat-a']
    })
    store.bootstrap()
    store.setViewport(1400, 900)

    const primaryPanelId = store.getPrimaryPanelId('terminal')
    assertCondition(Boolean(primaryPanelId), 'terminal primary panel should exist')
    store.startTabDragging(
      {
        tabId: 'term-b',
        kind: 'terminal',
        sourcePanelId: primaryPanelId!
      },
      300,
      300
    )
    store.setDropTarget(primaryPanelId!, 'right')
    store.commitDragging()
    assertEqual(store.panelCount, 3, 'layout should include chat plus two terminal panels before cleanup')

    const terminalPanels = store.panelNodes.filter((node) => node.panel.kind === 'terminal').map((node) => node.panel.id)
    assertEqual(terminalPanels.length, 2, 'should have two terminal panels after tab split')
    const detachedPanelId = terminalPanels.find((id) => id !== primaryPanelId)
    assertCondition(Boolean(detachedPanelId), 'detached terminal panel should exist')
    assertEqual(
      JSON.stringify(store.getPanelTabIds(detachedPanelId!)),
      JSON.stringify(['term-b']),
      'detached terminal panel should own dragged tab before cleanup'
    )

    const internal = store as any
    internal.appStore.terminalTabs = internal.appStore.terminalTabs.filter((tab: { id: string }) => tab.id !== 'term-b')
    if (internal.appStore.activeTerminalId === 'term-b') {
      internal.appStore.activeTerminalId = 'term-a'
    }
    store.syncPanelBindings({ persist: false })

    assertEqual(store.panelCount, 2, 'empty terminal panel should be removed automatically')
    const remainingTerminalPanels = store.panelNodes.filter((node) => node.panel.kind === 'terminal')
    assertEqual(remainingTerminalPanels.length, 1, 'only one terminal panel should remain after cleanup')
    const remainingTabIds = store.getPanelTabIds(remainingTerminalPanels[0].panel.id)
    assertEqual(JSON.stringify(remainingTabIds), JSON.stringify(['term-a']), 'remaining terminal panel should keep valid tab ids')
  })

  await runCase('removing primary panel keeps terminal tab bindings valid', async () => {
    const store = createStore({
      terminalIds: ['term-a', 'term-b']
    })
    store.bootstrap()
    store.setViewport(1400, 900)

    const originalPrimary = store.getPrimaryPanelId('terminal')
    assertCondition(Boolean(originalPrimary), 'terminal primary panel should exist')
    store.startTabDragging(
      {
        tabId: 'term-b',
        kind: 'terminal',
        sourcePanelId: originalPrimary!
      },
      240,
      240
    )
    store.setDropTarget(originalPrimary!, 'right')
    store.commitDragging()
    const terminalPanels = store.panelNodes.filter((node) => node.panel.kind === 'terminal').map((node) => node.panel.id)
    assertEqual(terminalPanels.length, 2, 'should have two terminal panels after tab split')
    assertCondition(store.canRemovePanel(originalPrimary!), 'original primary panel should be removable after split')

    store.removePanel(originalPrimary!)
    const nextPrimary = store.getPrimaryPanelId('terminal')
    assertCondition(Boolean(nextPrimary), 'next primary panel should exist')
    assertCondition(nextPrimary !== originalPrimary, 'primary panel should switch after removing original panel')
    const assigned = store
      .panelNodes
      .filter((node) => node.panel.kind === 'terminal')
      .flatMap((node) => store.getPanelTabIds(node.panel.id))
      .sort()
    assertEqual(JSON.stringify(assigned), JSON.stringify(['term-a', 'term-b']), 'all terminal tabs should remain assigned')
  })

  await runCase('tab center drop supports in-panel visual reorder before target tab', async () => {
    const store = createStore({
      terminalIds: ['term-a', 'term-b', 'term-c'],
      chatIds: ['chat-a']
    })
    store.bootstrap()
    store.setViewport(1400, 900)

    const primaryPanelId = store.getPrimaryPanelId('terminal')
    assertCondition(Boolean(primaryPanelId), 'terminal primary panel should exist')
    assertEqual(
      JSON.stringify(store.getPanelTabIds(primaryPanelId!)),
      JSON.stringify(['term-a', 'term-b', 'term-c']),
      'precondition: terminal tabs should be in owner order'
    )

    store.startTabDragging(
      {
        tabId: 'term-c',
        kind: 'terminal',
        sourcePanelId: primaryPanelId!
      },
      200,
      200
    )
    store.setTabReorderTarget(primaryPanelId!, 'term-a', 'before')
    store.setDropTarget(primaryPanelId!, 'center')
    store.commitDragging()

    assertEqual(
      JSON.stringify(store.getPanelTabIds(primaryPanelId!)),
      JSON.stringify(['term-c', 'term-a', 'term-b']),
      'center drop reorder should move dragged tab before target tab'
    )
  })

  await runCase('tab center drop supports cross-panel insertion position', async () => {
    const store = createStore({
      terminalIds: ['term-a', 'term-b', 'term-c'],
      chatIds: ['chat-a']
    })
    store.bootstrap()
    store.setViewport(1400, 900)

    const primaryPanelId = store.getPrimaryPanelId('terminal')
    assertCondition(Boolean(primaryPanelId), 'terminal primary panel should exist')

    store.startTabDragging(
      {
        tabId: 'term-c',
        kind: 'terminal',
        sourcePanelId: primaryPanelId!
      },
      220,
      220
    )
    store.setDropTarget(primaryPanelId!, 'right')
    store.commitDragging()

    const targetPanelId = store
      .panelNodes
      .filter((node) => node.panel.kind === 'terminal')
      .map((node) => node.panel.id)
      .find((id) => id !== primaryPanelId)
    assertCondition(Boolean(targetPanelId), 'target terminal panel should exist after split')
    assertEqual(
      JSON.stringify(store.getPanelTabIds(targetPanelId!)),
      JSON.stringify(['term-c']),
      'target panel should contain dragged tab after split'
    )

    store.startTabDragging(
      {
        tabId: 'term-a',
        kind: 'terminal',
        sourcePanelId: primaryPanelId!
      },
      260,
      260
    )
    store.setTabReorderTarget(targetPanelId!, 'term-c', 'before')
    store.setDropTarget(targetPanelId!, 'center')
    store.commitDragging()

    assertEqual(
      JSON.stringify(store.getPanelTabIds(targetPanelId!)),
      JSON.stringify(['term-a', 'term-c']),
      'center drop with target tab should insert dragged tab before target in destination panel'
    )
  })

  await runCase('splitTabToDirection moves selected tab instead of creating an empty panel', async () => {
    const store = createStore({
      terminalIds: ['term-a'],
      chatIds: ['chat-a']
    })
    store.bootstrap()
    store.setViewport(1400, 900)

    const primaryPanelId = store.getPrimaryPanelId('terminal')
    assertCondition(Boolean(primaryPanelId), 'terminal primary panel should exist before split')
    assertEqual(store.panelCount, 2, 'precondition: layout should contain chat and terminal panels')

    store.splitTabToDirection(
      {
        tabId: 'term-a',
        kind: 'terminal',
        sourcePanelId: primaryPanelId!
      },
      primaryPanelId!,
      'right'
    )

    const terminalPanels = store.panelNodes.filter((node) => node.panel.kind === 'terminal')
    assertEqual(terminalPanels.length, 1, 'single-tab split should not leave an extra empty terminal panel')
    assertEqual(store.panelCount, 2, 'single-tab split should keep total panel count stable')
    assertEqual(
      JSON.stringify(store.getPanelTabIds(terminalPanels[0].panel.id)),
      JSON.stringify(['term-a']),
      'the selected tab should remain alive and attached to the resulting terminal panel'
    )
  })

  await runCase('tab center drop accepts null anchor reorder target for empty destination tab bar', async () => {
    const store = createStore({
      terminalIds: ['term-a', 'term-b'],
      chatIds: ['chat-a']
    })
    store.bootstrap()
    store.setViewport(1400, 900)

    const primaryPanelId = store.getPrimaryPanelId('terminal')
    assertCondition(Boolean(primaryPanelId), 'terminal primary panel should exist')
    store.splitPanel(primaryPanelId!, 'terminal', 'horizontal', 'after')
    const destinationPanelId = store.tree.focusedPanelId
    assertCondition(Boolean(destinationPanelId), 'split should create a focused empty destination panel')
    assertEqual(store.getPanelTabIds(destinationPanelId!).length, 0, 'destination panel should be empty before insertion')

    store.startTabDragging(
      {
        tabId: 'term-b',
        kind: 'terminal',
        sourcePanelId: primaryPanelId!
      },
      260,
      260
    )
    store.setTabReorderTarget(destinationPanelId!, null, 'after')
    store.setDropTarget(destinationPanelId!, 'center')
    store.commitDragging()

    assertEqual(
      JSON.stringify(store.getPanelTabIds(destinationPanelId!)),
      JSON.stringify(['term-b']),
      'null-anchor reorder target should insert dragged tab into empty destination panel'
    )
  })

  await runCase('can remove the last panel of a kind when other kinds still exist', async () => {
    const store = createStore({
      terminalIds: ['term-a'],
      chatIds: ['chat-a']
    })
    const internal = store as any
    store.bootstrap()
    store.setViewport(1400, 900)

    const terminalPanelId = store.getPrimaryPanelId('terminal')
    const chatPanelId = store.getPrimaryPanelId('chat')
    assertCondition(Boolean(terminalPanelId), 'terminal panel should exist')
    assertCondition(Boolean(chatPanelId), 'chat panel should exist')
    assertCondition(store.canRemovePanel(terminalPanelId!), 'terminal panel should be removable')

    store.removePanel(terminalPanelId!)
    assertEqual(store.getPrimaryPanelId('terminal'), null, 'terminal panels can all be closed from layout')
    assertEqual(store.panelCount, 1, 'layout should still keep at least one panel in total')
    assertEqual(store.getPrimaryPanelId('chat'), chatPanelId, 'chat panel should remain intact')
    assertEqual(
      JSON.stringify(internal.appStore.terminalTabs.map((tab: { id: string }) => tab.id)),
      JSON.stringify(['term-a']),
      'removing a panel must not close owner terminal tabs'
    )
  })

  await runCase('cannot remove the final chat panel when other kinds still exist', async () => {
    const store = createStore({
      terminalIds: ['term-a'],
      chatIds: ['chat-a']
    })
    store.bootstrap()
    store.setViewport(1400, 900)

    const chatPanelId = store.getPrimaryPanelId('chat')
    const terminalPanelId = store.getPrimaryPanelId('terminal')
    assertCondition(Boolean(chatPanelId), 'chat panel should exist')
    assertCondition(Boolean(terminalPanelId), 'terminal panel should exist')
    assertEqual(store.panelCount, 2, 'default layout should start with one chat and one terminal panel')
    assertEqual(store.canRemovePanel(chatPanelId!), false, 'final chat panel should not be removable')

    store.removePanel(chatPanelId!)
    assertEqual(store.panelCount, 2, 'attempting to remove final chat panel should be a no-op')
    assertEqual(store.getPrimaryPanelId('chat'), chatPanelId, 'chat panel must remain present after blocked removal')
  })
}

void run()
  .then(() => {
    console.log('All LayoutStore extreme tests passed.')
  })
  .catch((error) => {
    console.error(error)
    throw error
  })
