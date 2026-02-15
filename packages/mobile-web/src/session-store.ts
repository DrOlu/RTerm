import type { ChatMessage, UIUpdateAction } from './types'

export interface SessionState {
  id: string
  title: string
  messages: ChatMessage[]
  isThinking: boolean
  isBusy: boolean
  lockedProfileId: string | null
}

export interface SessionMeta {
  id: string
  title: string
  updatedAt: number
  messagesCount: number
  lastMessagePreview?: string
  loaded: boolean
}

export function createSessionState(id: string, title = 'New Chat'): SessionState {
  return {
    id,
    title,
    messages: [],
    isThinking: false,
    isBusy: false,
    lockedProfileId: null
  }
}

export function cloneMessage(message: ChatMessage): ChatMessage {
  return {
    ...message,
    metadata: message.metadata ? { ...message.metadata } : undefined
  }
}

export function cloneSession(session: SessionState): SessionState {
  return {
    ...session,
    messages: session.messages.map(cloneMessage)
  }
}

export function applyUiUpdate(session: SessionState, update: UIUpdateAction): void {
  switch (update.type) {
    case 'ADD_MESSAGE': {
      const message = cloneMessage(update.message)
      // Keep reasoning transient in frontend: once any new message arrives, old reasoning is removed.
      session.messages = session.messages.filter((item) => item.type !== 'reasoning')
      session.messages.push(message)

      if (message.role === 'user') {
        session.isThinking = true
        session.isBusy = true
        const firstUser = session.messages.filter((item) => item.role === 'user').length === 1
        if (firstUser) {
          session.title = autoTitle(message.content)
        }
      }
      break
    }
    case 'REMOVE_MESSAGE': {
      session.messages = session.messages.filter((item) => item.id !== update.messageId)
      break
    }
    case 'APPEND_CONTENT': {
      const message = session.messages.find((item) => item.id === update.messageId)
      if (message) {
        message.content += update.content
        session.isBusy = true
      }
      break
    }
    case 'APPEND_OUTPUT': {
      const message = session.messages.find((item) => item.id === update.messageId)
      if (message) {
        message.metadata = {
          ...(message.metadata ?? {}),
          output: `${message.metadata?.output ?? ''}${update.outputDelta ?? ''}`
        }
        session.isBusy = true
      }
      break
    }
    case 'UPDATE_MESSAGE': {
      const message = session.messages.find((item) => item.id === update.messageId)
      if (message) {
        Object.assign(message, update.patch)
        session.isBusy = true
      }
      break
    }
    case 'DONE': {
      session.isThinking = false
      session.messages.forEach((item) => {
        item.streaming = false
      })
      break
    }
    case 'SESSION_READY': {
      session.isBusy = false
      session.lockedProfileId = null
      break
    }
    case 'ROLLBACK': {
      const index = session.messages.findIndex((item) => item.backendMessageId === update.messageId)
      if (index >= 0) {
        session.messages = session.messages.slice(0, index)
      }
      session.isThinking = false
      session.isBusy = false
      break
    }
  }
}

export function autoTitle(content: string): string {
  const normalized = normalizeDisplayText(content || '').replace(/\s+/g, ' ').trim()
  if (!normalized) return 'New Chat'
  return normalized.length <= 48 ? normalized : `${normalized.slice(0, 47)}...`
}

export function normalizeDisplayText(input: string): string {
  return String(input || '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\[MENTION_TAB:#([^#\]\r\n]+)(?:##[^#\]\r\n]*)?(?:#\])?/g, (_m, name: string) => `@${name}`)
    .replace(/\[MENTION_SKILL:#([^#\]\r\n]+)(?:#\])?/g, (_m, name: string) => `@${name}`)
    .replace(/\[MENTION_FILE:#([^#\]\r\n]+)(?:##[^#\]\r\n]*)?(?:#\])?/g, (_m, path: string) => path.split(/[/\\]/).pop() || path)
    .replace(/\[MENTION_USER_PASTE:#([^#\]\r\n]+)##([^#\]\r\n]+)(?:#\])?/g, (_m, _path: string, preview: string) => preview)
    .replace(/\s+$/g, '')
}

export function trimOuterBlankLines(input: string): string {
  const normalized = String(input || '').replace(/\r/g, '')
  return normalized
    .replace(/^\n+/, '')
    .replace(/\n+$/, '')
}

export function isEmptyMessageContent(message: ChatMessage): boolean {
  const content = normalizeDisplayText(message.content || '')
  const output = normalizeDisplayText(message.metadata?.output || '')
  return content.trim().length === 0 && output.trim().length === 0
}

export function previewFromSession(session: SessionState): string {
  const latest = [...session.messages]
    .reverse()
    .find((item) => item.type !== 'tokens_count' && !isEmptyMessageContent(item))

  if (!latest) return ''

  const base =
    latest.type === 'command'
      ? latest.metadata?.output || latest.content
      : latest.metadata?.output || latest.content

  return normalizeDisplayText(base).replace(/\s+/g, ' ').trim().slice(0, 140)
}

export function reorderSessionIds(order: string[], metaMap: Record<string, SessionMeta>): string[] {
  return [...new Set(order)].sort((left, right) => {
    const a = metaMap[left]
    const b = metaMap[right]
    return (b?.updatedAt ?? 0) - (a?.updatedAt ?? 0)
  })
}
