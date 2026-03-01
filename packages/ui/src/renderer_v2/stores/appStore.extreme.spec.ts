import { AppStore } from './AppStore'
import { ChatStore } from './ChatStore'
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

const runCase = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
  await fn()
  console.log(`PASS ${name}`)
}

const buildPersistedTree = (options?: {
  focusedPanelId?: string
}): LayoutTree => ({
  schemaVersion: 2,
  root: {
    type: 'split',
    id: 'root',
    direction: 'horizontal',
    children: [
      { type: 'panel', id: 'node-chat-a', panel: { id: 'panel-chat-a', kind: 'chat' } },
      { type: 'panel', id: 'node-chat-b', panel: { id: 'panel-chat-b', kind: 'chat' } },
      { type: 'panel', id: 'node-terminal', panel: { id: 'panel-terminal', kind: 'terminal' } }
    ],
    sizes: [34, 33, 33]
  },
  focusedPanelId: options?.focusedPanelId || 'panel-chat-b',
  panelTabs: {
    'panel-chat-a': {
      tabIds: ['chat-a'],
      activeTabId: 'chat-a'
    },
    'panel-chat-b': {
      tabIds: ['chat-b', 'chat-c'],
      activeTabId: 'chat-c'
    },
    'panel-terminal': {
      tabIds: ['term-a'],
      activeTabId: 'term-a'
    }
  }
})

const installBootstrapWindowMock = (
  layoutTree: LayoutTree,
  options?: {
    allChatHistory?: Array<{ id: string; title?: string }>
    uiMessagesBySessionId?: Record<string, any[]>
    getUiMessages?: (sessionId: string) => Promise<any[]>
    runtimeSnapshotsBySessionId?: Record<string, any>
    onUiUpdateRegister?: (callback: (action: any) => void) => void
    loadChatSessionCalls?: string[]
  }
): void => {
  const versionPayload = {
    status: 'up-to-date',
    currentVersion: '1.0.0',
    latestVersion: '1.0.0'
  }

  ;(globalThis as unknown as { document: unknown }).document = {
    documentElement: {
      style: {
        setProperty: () => {}
      }
    }
  }

  ;(globalThis as unknown as { window: unknown }).window = {
    gyshell: {
      settings: {
        get: async () => ({
          themeId: 'gyshell-dark',
          language: 'en',
          layout: {
            v2: layoutTree
          }
        }),
        set: async () => {}
      },
      uiSettings: {
        get: async () => ({})
      },
      themes: {
        getCustom: async () => []
      },
      agent: {
        onUiUpdate: (callback: (action: any) => void) => {
          options?.onUiUpdateRegister?.(callback)
        },
        getAllChatHistory: async () => options?.allChatHistory || [],
        getUiMessages: async (sessionId: string) => {
          if (options?.getUiMessages) {
            return await options.getUiMessages(sessionId)
          }
          return options?.uiMessagesBySessionId?.[sessionId] || []
        },
        getSessionSnapshot: async (sessionId: string) =>
          options?.runtimeSnapshotsBySessionId?.[sessionId] || {
            id: sessionId,
            isBusy: false,
            lockedProfileId: null
          },
        loadChatSession: async (sessionId: string) => {
          options?.loadChatSessionCalls?.push(sessionId)
          return null
        }
      },
      terminal: {
        onExit: () => {},
        onTabsUpdated: () => {},
        list: async () => ({
          terminals: [
            {
              id: 'term-a',
              title: 'Local',
              type: 'local',
              cols: 80,
              rows: 24,
              runtimeState: 'ready'
            }
          ]
        })
      },
      tools: {
        onMcpUpdated: () => {},
        onBuiltInUpdated: () => {}
      },
      skills: {
        onUpdated: () => {}
      },
      memory: {
        get: async () => ({
          filePath: '',
          content: ''
        })
      },
      accessTokens: {
        list: async () => []
      },
      version: {
        getState: async () => versionPayload,
        check: async () => versionPayload
      }
    }
  }
}

const run = async (): Promise<void> => {
  await runCase('collectPersistedChatInventoryState preserves focused chat active tab', async () => {
    const store = new AppStore()
    const layoutTree = buildPersistedTree({
      focusedPanelId: 'panel-chat-b'
    })

    const state = (store as any).collectPersistedChatInventoryState({ v2: layoutTree })
    assertEqual(
      JSON.stringify(state.tabIds),
      JSON.stringify(['chat-a', 'chat-b', 'chat-c']),
      'chat tab ids should preserve persisted ordering by panel binding'
    )
    assertEqual(
      state.preferredActiveTabId,
      'chat-c',
      'focused chat panel active tab should be restored as preferred active tab'
    )
  })

  await runCase('collectPersistedChatInventoryState falls back to first available active chat tab', async () => {
    const store = new AppStore()
    const layoutTree = buildPersistedTree({
      focusedPanelId: 'panel-terminal'
    })

    const state = (store as any).collectPersistedChatInventoryState({ v2: layoutTree })
    assertEqual(
      state.preferredActiveTabId,
      'chat-a',
      'first available active chat tab should be used when focused panel is not chat'
    )
  })

  await runCase('ChatStore hydration honors preferred active session id', async () => {
    const chatStore = new ChatStore()
    chatStore.hydrateSessionInventoryFromLayout(['chat-a', 'chat-b', 'chat-c'], 'chat-c')
    assertEqual(chatStore.activeSessionId, 'chat-c', 'preferred active chat session should win over default first tab fallback')
  })

  await runCase('AppStore bootstrap passes preferred active chat id into hydration', async () => {
    const layoutTree = buildPersistedTree({
      focusedPanelId: 'panel-chat-b'
    })
    installBootstrapWindowMock(layoutTree)

    const store = new AppStore()
    ;(store.layout as any).bootstrap = () => {}
    ;(store.layout as any).syncPanelBindings = () => {}
    ;(store as any).loadTools = async () => {}
    ;(store as any).loadSkills = async () => {}
    ;(store as any).loadMemory = async () => {}
    ;(store as any).loadCommandPolicyLists = async () => {}
    ;(store as any).loadAccessTokens = async () => {}
    ;(store as any).loadVersionState = async () => {}
    ;(store as any).checkVersion = async () => {}

    const originalHydrate = store.chat.hydrateSessionInventoryFromLayout.bind(store.chat)
    let capturedHydrationArgs: { tabIds: string[]; preferredActiveSessionId: string | null } | null = null
    store.chat.hydrateSessionInventoryFromLayout = ((tabIds: string[], preferredActiveSessionId?: string | null) => {
      capturedHydrationArgs = {
        tabIds: [...tabIds],
        preferredActiveSessionId: preferredActiveSessionId ?? null
      }
      originalHydrate(tabIds, preferredActiveSessionId)
    }) as ChatStore['hydrateSessionInventoryFromLayout']

    await store.bootstrap()
    assertCondition(!!capturedHydrationArgs, 'bootstrap should hydrate chat inventory exactly once')
    const hydrationArgs = capturedHydrationArgs || {
      tabIds: [],
      preferredActiveSessionId: null
    }
    assertEqual(
      JSON.stringify(hydrationArgs.tabIds),
      JSON.stringify(['chat-a', 'chat-b', 'chat-c']),
      'bootstrap should pass persisted chat tab ids in deterministic order'
    )
    assertEqual(
      hydrationArgs.preferredActiveSessionId,
      'chat-c',
      'bootstrap should pass preferred active chat session id to hydration'
    )
  })

  await runCase('AppStore bootstrap hydrates restored chat tabs with persisted titles/messages', async () => {
    const layoutTree = buildPersistedTree({
      focusedPanelId: 'panel-chat-b'
    })
    const loadChatSessionCalls: string[] = []
    installBootstrapWindowMock(layoutTree, {
      allChatHistory: [
        { id: 'chat-a', title: 'Alpha Chat' },
        { id: 'chat-b', title: 'Beta Chat' },
        { id: 'chat-c', title: 'Gamma Chat' }
      ],
      uiMessagesBySessionId: {
        'chat-a': [{ id: 'msg-a1', role: 'user', type: 'text', content: 'hello', timestamp: 1 }],
        'chat-b': [{ id: 'msg-b1', role: 'assistant', type: 'text', content: 'ok', timestamp: 2 }],
        'chat-c': [{ id: 'msg-c1', role: 'user', type: 'text', content: 'resume', timestamp: 3 }]
      },
      runtimeSnapshotsBySessionId: {
        'chat-c': {
          id: 'chat-c',
          isBusy: true,
          lockedProfileId: 'profile-1'
        }
      },
      loadChatSessionCalls
    })

    const store = new AppStore()
    ;(store.layout as any).bootstrap = () => {}
    ;(store.layout as any).syncPanelBindings = () => {}
    ;(store as any).loadTools = async () => {}
    ;(store as any).loadSkills = async () => {}
    ;(store as any).loadMemory = async () => {}
    ;(store as any).loadCommandPolicyLists = async () => {}
    ;(store as any).loadAccessTokens = async () => {}
    ;(store as any).loadVersionState = async () => {}
    ;(store as any).checkVersion = async () => {}

    await store.bootstrap()

    assertEqual(store.chat.getSessionById('chat-a')?.title, 'Alpha Chat', 'restored chat-a title should be hydrated')
    assertEqual(store.chat.getSessionById('chat-b')?.title, 'Beta Chat', 'restored chat-b title should be hydrated')
    assertEqual(store.chat.getSessionById('chat-c')?.title, 'Gamma Chat', 'restored chat-c title should be hydrated')
    assertEqual(store.chat.getSessionById('chat-c')?.messageIds.length, 1, 'restored chat-c messages should be hydrated')
    assertEqual(store.chat.activeSessionId, 'chat-c', 'preferred active restored tab should stay active after hydration')
    assertEqual(
      JSON.stringify(loadChatSessionCalls),
      JSON.stringify(['chat-c']),
      'bootstrap should load runtime backend context for active restored chat session'
    )
  })

  await runCase('reconcileTerminalTabs pins unresolved terminal panels only on first hydration', async () => {
    const store = new AppStore()
    let missingCallCount = 0
    let pinCallCount = 0
    let capturedIncomingIds: string[] = []
    let capturedPinnedPanels: string[] = []

    ;(store.layout as any).getPanelsWithMissingTabBindings = (_kind: string, ownerTabIds: string[]) => {
      missingCallCount += 1
      capturedIncomingIds = [...ownerTabIds]
      return ['panel-term-missing']
    }
    ;(store.layout as any).pinPanelsAsRestorePlaceholder = (panelIds: string[]) => {
      pinCallCount += 1
      capturedPinnedPanels = [...panelIds]
    }
    ;(store.layout as any).syncPanelBindings = () => {}

    store.reconcileTerminalTabs({
      terminals: [
        {
          id: 'term-1',
          title: 'Local',
          type: 'local',
          cols: 80,
          rows: 24,
          runtimeState: 'ready'
        }
      ]
    } as any)

    assertEqual(missingCallCount, 1, 'first hydration should detect unresolved terminal panels')
    assertEqual(pinCallCount, 1, 'first hydration should pin unresolved terminal panels')
    assertEqual(JSON.stringify(capturedIncomingIds), JSON.stringify(['term-1']), 'incoming ids should be forwarded to layout')
    assertEqual(
      JSON.stringify(capturedPinnedPanels),
      JSON.stringify(['panel-term-missing']),
      'layout should receive unresolved panel ids'
    )

    store.reconcileTerminalTabs({
      terminals: [
        {
          id: 'term-1',
          title: 'Local',
          type: 'local',
          cols: 120,
          rows: 40,
          runtimeState: 'ready'
        }
      ]
    } as any)

    assertEqual(missingCallCount, 1, 'subsequent updates should not re-run first hydration placeholder detection')
    assertEqual(pinCallCount, 1, 'subsequent updates should not re-pin placeholders')
  })

  await runCase('AppStore bootstrap should buffer ui updates emitted during chat hydration', async () => {
    const layoutTree = buildPersistedTree({
      focusedPanelId: 'panel-chat-b'
    })
    let uiUpdateHandler: ((action: any) => void) | null = null
    let resolveHydrationGate: (() => void) | null = null
    const hydrationGate = new Promise<void>((resolve) => {
      resolveHydrationGate = resolve
    })

    installBootstrapWindowMock(layoutTree, {
      allChatHistory: [
        { id: 'chat-a', title: 'Alpha Chat' },
        { id: 'chat-b', title: 'Beta Chat' },
        { id: 'chat-c', title: 'Gamma Chat' }
      ],
      onUiUpdateRegister: (callback) => {
        uiUpdateHandler = callback
      },
      getUiMessages: async (sessionId: string) => {
        if (sessionId === 'chat-c') {
          await hydrationGate
        }
        return []
      }
    })

    const store = new AppStore()
    ;(store.layout as any).bootstrap = () => {}
    ;(store.layout as any).syncPanelBindings = () => {}
    ;(store as any).loadTools = async () => {}
    ;(store as any).loadSkills = async () => {}
    ;(store as any).loadMemory = async () => {}
    ;(store as any).loadCommandPolicyLists = async () => {}
    ;(store as any).loadAccessTokens = async () => {}
    ;(store as any).loadVersionState = async () => {}
    ;(store as any).checkVersion = async () => {}

    const bootstrapPromise = store.bootstrap()
    for (let i = 0; i < 20 && !uiUpdateHandler; i += 1) {
      await Promise.resolve()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    assertCondition(!!uiUpdateHandler, 'bootstrap should register ui update listener before hydration awaits')

    uiUpdateHandler!({
      type: 'ADD_MESSAGE',
      sessionId: 'chat-c',
      message: {
        id: 'msg-during-hydration',
        role: 'assistant',
        type: 'text',
        content: 'streaming while hydrating',
        timestamp: 10
      }
    })

    resolveHydrationGate!()

    await bootstrapPromise

    const restoredSession = store.chat.getSessionById('chat-c')
    assertCondition(!!restoredSession, 'restored session should exist after bootstrap')
    assertCondition(
      restoredSession?.messageIds.includes('msg-during-hydration'),
      'ui update emitted during hydration should be replayed after hydration'
    )
  })

  await runCase('AppStore bootstrap replay should not duplicate messages already present in hydrated snapshot', async () => {
    const layoutTree = buildPersistedTree({
      focusedPanelId: 'panel-chat-b'
    })
    let uiUpdateHandler: ((action: any) => void) | null = null
    let resolveHydrationGate: (() => void) | null = null
    const hydrationGate = new Promise<void>((resolve) => {
      resolveHydrationGate = resolve
    })

    installBootstrapWindowMock(layoutTree, {
      allChatHistory: [
        { id: 'chat-a', title: 'Alpha Chat' },
        { id: 'chat-b', title: 'Beta Chat' },
        { id: 'chat-c', title: 'Gamma Chat' }
      ],
      onUiUpdateRegister: (callback) => {
        uiUpdateHandler = callback
      },
      getUiMessages: async (sessionId: string) => {
        if (sessionId === 'chat-c') {
          await hydrationGate
          return [
            {
              id: 'msg-shared',
              role: 'assistant',
              type: 'text',
              content: 'shared message',
              timestamp: 20
            }
          ]
        }
        return []
      }
    })

    const store = new AppStore()
    ;(store.layout as any).bootstrap = () => {}
    ;(store.layout as any).syncPanelBindings = () => {}
    ;(store as any).loadTools = async () => {}
    ;(store as any).loadSkills = async () => {}
    ;(store as any).loadMemory = async () => {}
    ;(store as any).loadCommandPolicyLists = async () => {}
    ;(store as any).loadAccessTokens = async () => {}
    ;(store as any).loadVersionState = async () => {}
    ;(store as any).checkVersion = async () => {}

    const bootstrapPromise = store.bootstrap()
    for (let i = 0; i < 20 && !uiUpdateHandler; i += 1) {
      await Promise.resolve()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    assertCondition(!!uiUpdateHandler, 'bootstrap should register ui update listener before hydration awaits')

    uiUpdateHandler!({
      type: 'ADD_MESSAGE',
      sessionId: 'chat-c',
      message: {
        id: 'msg-shared',
        role: 'assistant',
        type: 'text',
        content: 'shared message',
        timestamp: 20
      }
    })

    resolveHydrationGate!()
    await bootstrapPromise

    const restoredSession = store.chat.getSessionById('chat-c')
    assertCondition(!!restoredSession, 'restored session should exist after bootstrap')
    const duplicateCount = restoredSession?.messageIds.filter((id) => id === 'msg-shared').length || 0
    assertEqual(duplicateCount, 1, 'deferred replay should not duplicate hydrated message ids')
  })
}

void run()
  .then(() => {
    console.log('All AppStore extreme tests passed.')
  })
  .catch((error) => {
    console.error(error)
    throw error
  })
