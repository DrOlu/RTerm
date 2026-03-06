import type {
  WindowingMessage,
  WindowingDragStartMessage,
  WindowingDragEndMessage,
  WindowingTabMovedMessage
} from './windowing'
import {
  createWindowingChannel,
  WINDOWING_STORAGE_CHANNEL_KEY
} from './windowing'
import type { PanelKind } from '../layout'

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(`${message}. expected=${String(expected)} actual=${String(actual)}`)
  }
}

const assertCondition = (condition: unknown, message: string): void => {
  if (!condition) {
    throw new Error(message)
  }
}

const assertDeepEqual = (actual: unknown, expected: unknown, message: string): void => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}. expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`)
  }
}

const runCase = (name: string, fn: () => void): void => {
  fn()
  console.log(`PASS ${name}`)
}

// ---------------------------------------------------------------------------
// WindowingDragStartMessage type checks
// ---------------------------------------------------------------------------

runCase('drag-start message with tab payload is valid WindowingMessage', () => {
  const msg: WindowingDragStartMessage = {
    type: 'drag-start',
    sourceClientId: 'win-abc',
    tabPayload: {
      sourceClientId: 'win-abc',
      tabId: 'tab-1',
      kind: 'terminal',
      sourcePanelId: 'panel-term-1'
    }
  }
  const asMessage: WindowingMessage = msg
  assertEqual(asMessage.type, 'drag-start', 'drag-start should be a valid WindowingMessage type')
  assertCondition(msg.tabPayload, 'tabPayload should be present')
  assertEqual(msg.tabPayload!.tabId, 'tab-1', 'tabPayload.tabId should match')
  assertEqual(msg.tabPayload!.kind, 'terminal', 'tabPayload.kind should match')
})

runCase('drag-end message is valid WindowingMessage', () => {
  const msg: WindowingDragEndMessage = {
    type: 'drag-end',
    sourceClientId: 'win-123'
  }
  const asMessage: WindowingMessage = msg
  assertEqual(asMessage.type, 'drag-end', 'drag-end should be a valid WindowingMessage type')
  assertEqual(msg.sourceClientId, 'win-123', 'sourceClientId should match')
})

runCase('file protocol falls back to storage-backed windowing channel', () => {
  const originalWindow = (globalThis as any).window
  const originalBroadcastChannel = (globalThis as any).BroadcastChannel
  const listeners = new Set<(event: { key: string | null; newValue: string | null }) => void>()
  const writes: Array<{ key: string; value: string | null }> = []
  let broadcastChannelConstructed = 0

  ;(globalThis as any).window = {
    location: { protocol: 'file:' },
    localStorage: {
      removeItem(key: string) {
        writes.push({ key, value: null })
      },
      setItem(key: string, value: string) {
        writes.push({ key, value })
      }
    },
    addEventListener(type: string, listener: (event: { key: string | null; newValue: string | null }) => void) {
      if (type === 'storage') {
        listeners.add(listener)
      }
    },
    removeEventListener(type: string, listener: (event: { key: string | null; newValue: string | null }) => void) {
      if (type === 'storage') {
        listeners.delete(listener)
      }
    }
  }
  ;(globalThis as any).BroadcastChannel = class {
    constructor() {
      broadcastChannelConstructed += 1
    }
  }

  try {
    const channel = createWindowingChannel()
    assertCondition(channel !== null, 'storage-backed channel should be created')
    assertEqual(broadcastChannelConstructed, 0, 'file protocol should not construct BroadcastChannel')

    let received: WindowingMessage | null = null
    channel!.onmessage = (event) => {
      received = event.data
    }

    const outboundMessage: WindowingDragEndMessage = {
      type: 'drag-end',
      sourceClientId: 'win-source'
    }
    channel!.postMessage(outboundMessage)
    assertDeepEqual(
      writes,
      [
        { key: WINDOWING_STORAGE_CHANNEL_KEY, value: null },
        { key: WINDOWING_STORAGE_CHANNEL_KEY, value: JSON.stringify(outboundMessage) }
      ],
      'storage-backed channel should write serialized payload via localStorage'
    )

    const inboundMessage: WindowingDragEndMessage = {
      type: 'drag-end',
      sourceClientId: 'win-target'
    }
    listeners.forEach((listener) => {
      listener({
        key: WINDOWING_STORAGE_CHANNEL_KEY,
        newValue: JSON.stringify(inboundMessage)
      })
    })
    assertDeepEqual(received, inboundMessage, 'storage event should deliver payload to onmessage')

    channel!.close()
    assertEqual(listeners.size, 0, 'closing the channel should remove the storage listener')
  } finally {
    ;(globalThis as any).window = originalWindow
    ;(globalThis as any).BroadcastChannel = originalBroadcastChannel
  }
})

// ---------------------------------------------------------------------------
// Cross-window drag message coordination protocol validation
// ---------------------------------------------------------------------------

runCase('drag-start and drag-end form a valid lifecycle', () => {
  const clientId = 'win-source'
  const startMsg: WindowingDragStartMessage = {
    type: 'drag-start',
    sourceClientId: clientId,
    tabPayload: {
      sourceClientId: clientId,
      tabId: 'term-1',
      kind: 'terminal',
      sourcePanelId: 'panel-term-1'
    }
  }
  const endMsg: WindowingDragEndMessage = {
    type: 'drag-end',
    sourceClientId: clientId
  }

  // Simulate cross-window drag ref tracking
  let crossWindowDrag: WindowingDragStartMessage | null = null

  // Source window sends drag-start
  crossWindowDrag = startMsg
  assertCondition(crossWindowDrag !== null, 'cross-window drag should be set after drag-start')
  assertEqual(crossWindowDrag!.sourceClientId, clientId, 'source client should match')

  // Source window sends drag-end
  if (crossWindowDrag?.sourceClientId === endMsg.sourceClientId) {
    crossWindowDrag = null
  }
  assertEqual(crossWindowDrag, null, 'cross-window drag should be cleared after drag-end')
})

runCase('drag-start from same window should be ignored by receiver', () => {
  const localClientId = 'win-local'
  const msg: WindowingDragStartMessage = {
    type: 'drag-start',
    sourceClientId: localClientId,
    tabPayload: {
      sourceClientId: localClientId,
      tabId: 'tab-1',
      kind: 'chat',
      sourcePanelId: 'panel-chat-1'
    }
  }

  // Receiver logic: ignore if sourceClientId matches local clientId
  const shouldAccept = msg.sourceClientId !== localClientId
  assertEqual(shouldAccept, false, 'drag-start from same window should be ignored')
})

runCase('drag-start from different window should be accepted by receiver', () => {
  const localClientId = 'win-local'
  const msg: WindowingDragStartMessage = {
    type: 'drag-start',
    sourceClientId: 'win-remote',
    tabPayload: {
      sourceClientId: 'win-remote',
      tabId: 'tab-1',
      kind: 'terminal',
      sourcePanelId: 'panel-term-1'
    }
  }

  const shouldAccept = msg.sourceClientId !== localClientId
  assertEqual(shouldAccept, true, 'drag-start from different window should be accepted')
})

// ---------------------------------------------------------------------------
// PanelKind validation in drag payloads
// ---------------------------------------------------------------------------

runCase('all panel kinds are valid in tab drag payload', () => {
  const kinds: PanelKind[] = ['chat', 'terminal', 'filesystem', 'fileEditor']
  kinds.forEach((kind) => {
    const msg: WindowingDragStartMessage = {
      type: 'drag-start',
      sourceClientId: 'win-1',
      tabPayload: {
        sourceClientId: 'win-1',
        tabId: `tab-${kind}`,
        kind,
        sourcePanelId: `panel-${kind}`
      }
    }
    assertEqual(msg.tabPayload!.kind, kind, `kind ${kind} should be accepted in tab drag payload`)
  })
})

// ---------------------------------------------------------------------------
// Tab-moved integration with drag protocol
// ---------------------------------------------------------------------------

runCase('tab-moved message completes cross-window tab drag lifecycle', () => {
  const sourceClientId = 'win-source'
  const targetClientId = 'win-target'

  // Step 1: drag-start broadcast from source
  const dragStart: WindowingDragStartMessage = {
    type: 'drag-start',
    sourceClientId,
    tabPayload: {
      sourceClientId,
      tabId: 'term-1',
      kind: 'terminal',
      sourcePanelId: 'panel-term-src'
    }
  }

  // Step 2: target window receives drag, accepts drop, sends tab-moved
  const tabMoved: WindowingTabMovedMessage = {
    type: 'tab-moved',
    sourceClientId,
    targetClientId,
    kind: 'terminal',
    tabId: 'term-1'
  }

  // Step 3: source receives tab-moved and cleans up
  assertEqual(tabMoved.sourceClientId, sourceClientId, 'tab-moved sourceClientId should match drag source')
  assertEqual(tabMoved.tabId, dragStart.tabPayload!.tabId, 'tab-moved tabId should match dragged tab')
  assertEqual(tabMoved.kind, dragStart.tabPayload!.kind, 'tab-moved kind should match dragged tab kind')
})

// ---------------------------------------------------------------------------
// Drag-end clears only matching source
// ---------------------------------------------------------------------------

runCase('drag-end only clears matching source client', () => {
  let crossWindowDrag: WindowingDragStartMessage | null = {
    type: 'drag-start',
    sourceClientId: 'win-A',
    tabPayload: { sourceClientId: 'win-A', tabId: 't1', kind: 'terminal', sourcePanelId: 'p1' }
  }

  // drag-end from a DIFFERENT source should NOT clear
  const endFromOther: WindowingDragEndMessage = {
    type: 'drag-end',
    sourceClientId: 'win-B'
  }
  if (crossWindowDrag?.sourceClientId === endFromOther.sourceClientId) {
    crossWindowDrag = null
  }
  assertCondition(crossWindowDrag !== null, 'drag-end from different source should not clear ref')

  // drag-end from matching source SHOULD clear
  const endFromSame: WindowingDragEndMessage = {
    type: 'drag-end',
    sourceClientId: 'win-A'
  }
  if (crossWindowDrag?.sourceClientId === endFromSame.sourceClientId) {
    crossWindowDrag = null
  }
  assertEqual(crossWindowDrag, null, 'drag-end from matching source should clear ref')
})

console.log('All windowing cross-window drag extreme tests passed.')
