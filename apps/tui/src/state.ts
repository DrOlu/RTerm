import type { ChatMessage, UIUpdateAction } from './protocol'

export interface SessionState {
  id: string
  title: string
  terminalId: string
  messages: ChatMessage[]
  isThinking: boolean
  isBusy: boolean
  lockedProfileId: string | null
}

export function createSessionState(id: string, terminalId: string, title = 'New Chat'): SessionState {
  return {
    id,
    title,
    terminalId,
    messages: [],
    isThinking: false,
    isBusy: false,
    lockedProfileId: null,
  }
}

export function applyUiUpdate(session: SessionState, update: UIUpdateAction): void {
  switch (update.type) {
    case 'ADD_MESSAGE': {
      const msg = update.message
      session.messages.push(msg)

      if (msg.role === 'user') {
        session.isThinking = true
        session.isBusy = true
        const firstUser = session.messages.filter((item) => item.role === 'user').length === 1
        if (firstUser) {
          session.title = autoTitle(msg.content)
        }
      }
      break
    }
    case 'REMOVE_MESSAGE': {
      session.messages = session.messages.filter((item) => item.id !== update.messageId)
      break
    }
    case 'APPEND_CONTENT': {
      const msg = session.messages.find((item) => item.id === update.messageId)
      if (msg) {
        msg.content += update.content
      }
      break
    }
    case 'APPEND_OUTPUT': {
      const msg = session.messages.find((item) => item.id === update.messageId)
      if (msg) {
        msg.metadata = {
          ...(msg.metadata ?? {}),
          output: `${msg.metadata?.output ?? ''}${update.outputDelta ?? ''}`,
        }
      }
      break
    }
    case 'UPDATE_MESSAGE': {
      const msg = session.messages.find((item) => item.id === update.messageId)
      if (msg) Object.assign(msg, update.patch)
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

export function findLatestPendingAsk(session: SessionState): ChatMessage | undefined {
  for (let i = session.messages.length - 1; i >= 0; i -= 1) {
    const message = session.messages[i]
    if (message.type === 'ask' && !message.metadata?.decision) {
      return message
    }
  }
  return undefined
}

export function compactMessageSummary(message: ChatMessage, showDetails: boolean): string {
  const short = (text: string, max = 120) => {
    const normalized = text.replace(/\s+/g, ' ').trim()
    if (normalized.length <= max) return normalized
    return `${normalized.slice(0, max - 1)}...`
  }

  if (message.type === 'text') {
    return short(message.content, showDetails ? 400 : 160)
  }

  if (message.type === 'command') {
    const command = message.content || message.metadata?.command || ''
    const output = message.metadata?.output ?? ''
    const suffix = showDetails && output ? ` | ${short(output, 140)}` : ''
    return `$ ${short(command, 80)}${suffix}`
  }

  if (message.type === 'tool_call') {
    const name = message.metadata?.toolName ?? 'tool'
    return `${name}: ${short(message.content, showDetails ? 180 : 80)}`
  }

  if (message.type === 'file_edit') {
    const file = message.metadata?.filePath ?? 'unknown file'
    const action = message.metadata?.action ?? 'edited'
    const stats = summarizeDiff(message.metadata?.diff ?? '')
    return `${action} ${file}${stats}`
  }

  if (message.type === 'sub_tool' || message.type === 'reasoning') {
    const title = message.metadata?.subToolTitle ?? 'sub tool'
    const hint = message.metadata?.subToolHint ? ` (${message.metadata.subToolHint})` : ''
    return `${title}${hint}`
  }

  if (message.type === 'ask') {
    const command = message.metadata?.command || message.content || ''
    return `permission required: ${short(command, 120)}`
  }

  if (message.type === 'alert') return `alert: ${short(message.content, 120)}`
  if (message.type === 'error') return `error: ${short(message.content, 120)}`

  return short(message.content, 120)
}

function summarizeDiff(diff: string): string {
  if (!diff) return ''

  const lines = diff.split('\n')
  let added = 0
  let removed = 0

  for (const line of lines) {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) continue
    if (line.startsWith('+')) added += 1
    if (line.startsWith('-')) removed += 1
  }

  const parts: string[] = []
  if (added > 0) parts.push(`+${added}`)
  if (removed > 0) parts.push(`-${removed}`)
  if (!parts.length) return ''
  return ` (${parts.join(' ')})`
}

function autoTitle(content: string): string {
  const normalized = String(content || '').replace(/\s+/g, ' ').trim()
  if (!normalized) return 'New Chat'
  if (normalized.length <= 48) return normalized
  return `${normalized.slice(0, 47)}...`
}
