import type { LayoutPanelTabBinding, LayoutTree, PanelKind } from '../layout'
import {
  normalizeFileEditorSnapshot,
  type FileEditorSnapshot
} from './fileEditorSnapshot'

export type RendererWindowRole = 'main' | 'detached'

const DETACHED_STATE_KEY_PREFIX = 'gyshell.detachedState.'
const WINDOW_CLIENT_ID_KEY = 'gyshell.windowClientId'
export const WINDOWING_BROADCAST_CHANNEL = 'gyshell-windowing-v1'
const WINDOWING_STORAGE_CHANNEL_KEY_PREFIX = 'gyshell.windowingChannel.'
export const WINDOWING_STORAGE_CHANNEL_KEY = `${WINDOWING_STORAGE_CHANNEL_KEY_PREFIX}${WINDOWING_BROADCAST_CHANNEL}`

export interface RendererWindowContext {
  role: RendererWindowRole
  detachedStateToken: string | null
  sourceClientId: string | null
  clientId: string
}

export interface DetachedWindowState {
  sourceClientId: string
  layoutTree: LayoutTree
  createdAt: number
  fileEditorSnapshot?: FileEditorSnapshot
}

export interface WindowingMergePanelPayload {
  kind: PanelKind
  tabBinding?: LayoutPanelTabBinding
}

export interface WindowingTabMovedMessage {
  type: 'tab-moved'
  sourceClientId: string
  targetClientId: string
  kind: PanelKind
  tabId: string
}

export interface WindowingMergeToMainMessage {
  type: 'merge-to-main'
  sourceClientId: string
  mode: 'tab' | 'panel'
  kind: PanelKind
  tabId?: string
  panel?: WindowingMergePanelPayload
}

export interface WindowingDetachedClosingMessage {
  type: 'detached-closing'
  sourceClientId: string
  tabsByKind: Partial<Record<Extract<PanelKind, 'chat' | 'terminal' | 'filesystem'>, string[]>>
}

/**
 * Broadcast when a drag starts in any window, so other windows can accept
 * the drop even when DataTransfer.getData() is restricted during dragover.
 */
export interface WindowingDragStartMessage {
  type: 'drag-start'
  sourceClientId: string
  tabPayload: {
    sourceClientId: string
    tabId: string
    kind: PanelKind
    sourcePanelId: string
  }
}

/**
 * Broadcast when a drag ends (drop or cancel) so other windows can clean up.
 */
export interface WindowingDragEndMessage {
  type: 'drag-end'
  sourceClientId: string
}

export type WindowingMessage =
  | WindowingTabMovedMessage
  | WindowingMergeToMainMessage
  | WindowingDetachedClosingMessage
  | WindowingDragStartMessage
  | WindowingDragEndMessage

const safeRandomId = (): string => {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }
  return `${Math.random().toString(16).slice(2)}-${Date.now().toString(16)}`
}

const readSearchParams = (): URLSearchParams => {
  try {
    const search = typeof window !== 'undefined' ? window.location?.search || '' : ''
    return new URLSearchParams(search)
  } catch {
    return new URLSearchParams()
  }
}

const ensureClientId = (): string => {
  try {
    const existing = window.sessionStorage?.getItem(WINDOW_CLIENT_ID_KEY)
    if (existing && existing.trim().length > 0) {
      return existing
    }
    const next = `win-${safeRandomId()}`
    window.sessionStorage?.setItem(WINDOW_CLIENT_ID_KEY, next)
    return next
  } catch {
    return `win-${safeRandomId()}`
  }
}

const readWindowContext = (): RendererWindowContext => {
  const params = readSearchParams()
  const role = params.get('windowRole') === 'detached' ? 'detached' : 'main'
  const detachedStateToken = params.get('detachedStateToken')
  const sourceClientId = params.get('sourceClientId')
  return {
    role,
    detachedStateToken: detachedStateToken && detachedStateToken.trim().length > 0 ? detachedStateToken : null,
    sourceClientId: sourceClientId && sourceClientId.trim().length > 0 ? sourceClientId : null,
    clientId: ensureClientId()
  }
}

export const WINDOW_CONTEXT: RendererWindowContext = readWindowContext()

export const stashDetachedWindowState = (token: string, state: DetachedWindowState): boolean => {
  const normalizedToken = String(token || '').trim()
  if (!normalizedToken) return false
  try {
    window.localStorage?.setItem(`${DETACHED_STATE_KEY_PREFIX}${normalizedToken}`, JSON.stringify(state))
    return true
  } catch {
    return false
  }
}

export const consumeDetachedWindowState = (token: string): DetachedWindowState | null => {
  const normalizedToken = String(token || '').trim()
  if (!normalizedToken) return null
  const key = `${DETACHED_STATE_KEY_PREFIX}${normalizedToken}`
  try {
    const raw = window.localStorage?.getItem(key)
    if (!raw) return null
    window.localStorage?.removeItem(key)
    const parsed = JSON.parse(raw) as Partial<DetachedWindowState>
    if (!parsed || typeof parsed !== 'object') return null
    if (!parsed.layoutTree || typeof parsed.layoutTree !== 'object') return null
    const sourceClientId = typeof parsed.sourceClientId === 'string' ? parsed.sourceClientId.trim() : ''
    if (!sourceClientId) return null
    const fileEditorSnapshot = normalizeFileEditorSnapshot((parsed as any).fileEditorSnapshot)
    return {
      sourceClientId,
      layoutTree: parsed.layoutTree as LayoutTree,
      createdAt: Number.isFinite(parsed.createdAt) ? Number(parsed.createdAt) : Date.now(),
      ...(fileEditorSnapshot ? { fileEditorSnapshot } : {})
    }
  } catch {
    return null
  }
}

/**
 * A channel interface compatible with BroadcastChannel for cross-window messaging.
 * For file:// renderer windows, BroadcastChannel is not reliable because those
 * documents are usually treated as opaque origins. In that case we fall back to
 * localStorage + the storage event, similar to VS Code's renderer-side channel.
 */
export interface WindowingChannel {
  postMessage(message: WindowingMessage): void
  onmessage: ((event: { data: WindowingMessage }) => void) | null
  close(): void
}

const createStorageWindowingChannel = (): WindowingChannel | null => {
  if (typeof window === 'undefined') {
    return null
  }

  let storage: Storage | null = null
  try {
    storage = window.localStorage ?? null
  } catch {
    storage = null
  }
  if (!storage) {
    return null
  }

  let messageHandler: ((event: { data: WindowingMessage }) => void) | null = null
  const handleStorage = (event: StorageEvent) => {
    if (event.key !== WINDOWING_STORAGE_CHANNEL_KEY || !event.newValue) {
      return
    }
    try {
      const payload = JSON.parse(event.newValue) as WindowingMessage
      messageHandler?.({ data: payload })
    } catch {
      // ignore malformed windowing payloads
    }
  }

  window.addEventListener('storage', handleStorage)
  return {
    postMessage(message: WindowingMessage) {
      try {
        storage?.removeItem(WINDOWING_STORAGE_CHANNEL_KEY)
        storage?.setItem(WINDOWING_STORAGE_CHANNEL_KEY, JSON.stringify(message))
      } catch {
        // ignore storage broadcast errors
      }
    },
    get onmessage() {
      return messageHandler
    },
    set onmessage(handler: ((event: { data: WindowingMessage }) => void) | null) {
      messageHandler = handler
    },
    close() {
      window.removeEventListener('storage', handleStorage)
      messageHandler = null
    }
  }
}

export const createWindowingChannel = (): WindowingChannel | null => {
  const isFileProtocol = (() => {
    try {
      return window.location?.protocol === 'file:'
    } catch {
      return false
    }
  })()

  if (!isFileProtocol && typeof BroadcastChannel !== 'undefined') {
    try {
      return new BroadcastChannel(WINDOWING_BROADCAST_CHANNEL) as unknown as WindowingChannel
    } catch {
      return createStorageWindowingChannel()
    }
  }

  return createStorageWindowingChannel()
}
