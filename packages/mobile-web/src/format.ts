import type { ChatMessage } from './types'
import { normalizeDisplayText, trimOuterBlankLines } from './session-store'

export function formatClock(timestamp: number): string {
  if (!timestamp) return '--:--'
  const date = new Date(timestamp)
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function formatRelativeTime(timestamp: number): string {
  if (!timestamp) return 'just now'
  const delta = Date.now() - timestamp
  const minute = 60_000
  const hour = minute * 60
  const day = hour * 24

  if (delta < minute) return 'just now'
  if (delta < hour) return `${Math.floor(delta / minute)}m ago`
  if (delta < day) return `${Math.floor(delta / hour)}h ago`
  return `${Math.floor(delta / day)}d ago`
}

export function messageTypeTitle(message: ChatMessage): string {
  switch (message.type) {
    case 'command':
      return 'Command Run'
    case 'tool_call':
      return message.metadata?.toolName || 'Tool Call'
    case 'file_edit':
      return message.metadata?.action === 'created' ? 'File Created' : 'File Edited'
    case 'sub_tool':
      return message.metadata?.subToolTitle || 'Sub Tool'
    case 'reasoning':
      return message.metadata?.subToolTitle || 'Reasoning'
    case 'alert':
      return 'Alert'
    case 'error':
      return 'Error'
    case 'ask':
      return 'Permission Required'
    default:
      return 'Message'
  }
}

export function messageDetail(message: ChatMessage): string {
  if (message.type === 'command') {
    const output = trimOuterBlankLines(normalizeDisplayText(message.metadata?.output || ''))
    const command = trimOuterBlankLines(normalizeDisplayText(message.content || message.metadata?.command || ''))
    if (output) return `${command}\n\n${output}`
    return command
  }

  if (message.type === 'file_edit') {
    const path = message.metadata?.filePath || 'unknown file'
    const diff = trimOuterBlankLines(normalizeDisplayText(message.metadata?.diff || ''))
    const summary = message.content ? trimOuterBlankLines(normalizeDisplayText(message.content)) : ''
    const head = `${path}${summary ? `\n${summary}` : ''}`
    if (!diff) return head
    return `${head}\n\n${diff}`
  }

  if (message.type === 'ask') {
    return trimOuterBlankLines(normalizeDisplayText(message.metadata?.command || message.content || ''))
  }

  const base = message.metadata?.output || message.content || ''
  return trimOuterBlankLines(normalizeDisplayText(base))
}

export function clipMultiline(text: string, maxLines: number, maxChars = 420): string {
  const normalized = String(text || '')
  if (!normalized) return ''

  const lines = normalized.split('\n')
  if (lines.length > maxLines) {
    return `${lines.slice(0, maxLines).join('\n')}\n... (${lines.length - maxLines} more lines)`
  }

  if (normalized.length > maxChars) {
    return `${normalized.slice(0, maxChars).trimEnd()}\n... (${normalized.length - maxChars} more chars)`
  }

  return normalized
}
