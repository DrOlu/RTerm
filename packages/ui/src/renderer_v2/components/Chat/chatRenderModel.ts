import type { ChatMessage, ChatSession } from '../../stores/ChatStore'

export type ChatVisibleRowKind = 'assistant' | 'user'

export interface ChatRenderItem {
  id: string
  kind: ChatVisibleRowKind
  estimatedHeight: number
  mergeWithPreviousAssistant: boolean
  showAssistantGroupCopy: boolean
  assistantGroupMessageIds: string[]
}

type RowDisplayKind = ChatVisibleRowKind | 'hidden'

interface VisibleRow {
  id: string
  kind: ChatVisibleRowKind
  msg: ChatMessage
}

const SPECIAL_ASSISTANT_TYPES: ReadonlySet<ChatMessage['type']> = new Set([
  'command',
  'tool_call',
  'file_edit',
  'sub_tool',
  'reasoning',
  'compaction',
  'ask',
  'alert',
  'error',
])

const isCompletedWhitespaceAssistantText = (message: ChatMessage): boolean =>
  message.role === 'assistant' &&
  message.type === 'text' &&
  message.streaming !== true &&
  !/\S/.test(String(message.content || ''))

const getRowDisplayKind = (
  session: ChatSession,
  messageId: string,
  lastMessageId: string | null,
): RowDisplayKind => {
  const candidate = session.messagesById.get(messageId)
  if (!candidate) return 'hidden'
  if (candidate.type === 'tokens_count') return 'hidden'
  if (candidate.role === 'user') return 'user'
  if (isCompletedWhitespaceAssistantText(candidate)) return 'hidden'

  const isLastInSession = lastMessageId === messageId
  const isRetryHint =
    candidate.type === 'alert' && candidate.metadata?.subToolLevel === 'info'
  if (isRetryHint && !isLastInSession) return 'hidden'
  if (
    (candidate.type === 'reasoning' || candidate.type === 'compaction') &&
    !isLastInSession
  ) {
    return 'hidden'
  }
  if (SPECIAL_ASSISTANT_TYPES.has(candidate.type)) return 'assistant'
  return candidate.role === 'assistant' ? 'assistant' : 'hidden'
}

const estimateRowHeight = (
  message: ChatMessage,
  kind: ChatVisibleRowKind,
): number => {
  if (kind === 'user') {
    return Array.isArray(message.metadata?.inputImages) &&
      message.metadata.inputImages.length > 0
      ? 156
      : 92
  }

  switch (message.type) {
    case 'command':
      return 168
    case 'tool_call':
      return 150
    case 'file_edit':
      return 176
    case 'sub_tool':
    case 'reasoning':
    case 'compaction':
      return 160
    case 'ask':
      return 132
    case 'alert':
    case 'error':
      return 118
    default:
      return 140
  }
}

export const buildChatRenderItems = (
  session: ChatSession | null,
  isThinking: boolean,
): ChatRenderItem[] => {
  if (!session) return []

  const visibleRows: VisibleRow[] = []
  const lastMessageId =
    session.messageIds.length > 0
      ? session.messageIds[session.messageIds.length - 1]
      : null

  session.messageIds.forEach((messageId) => {
    const msg = session.messagesById.get(messageId)
    if (!msg) return

    const kind = getRowDisplayKind(session, messageId, lastMessageId)
    if (kind === 'hidden') return

    visibleRows.push({
      id: messageId,
      kind,
      msg,
    })
  })

  const items: ChatRenderItem[] = []
  let visibleIndex = 0
  while (visibleIndex < visibleRows.length) {
    const row = visibleRows[visibleIndex]
    if (row.kind !== 'assistant') {
      items.push({
        id: row.id,
        kind: row.kind,
        estimatedHeight: estimateRowHeight(row.msg, row.kind),
        mergeWithPreviousAssistant: false,
        showAssistantGroupCopy: false,
        assistantGroupMessageIds: [],
      })
      visibleIndex += 1
      continue
    }

    const runStart = visibleIndex
    const assistantGroupMessageIds: string[] = [row.id]
    while (
      visibleIndex + 1 < visibleRows.length &&
      visibleRows[visibleIndex + 1].kind === 'assistant'
    ) {
      visibleIndex += 1
      assistantGroupMessageIds.push(visibleRows[visibleIndex].id)
    }

    const runEnd = visibleIndex
    const nextVisibleRow = visibleRows[runEnd + 1]
    const nextVisibleKind = nextVisibleRow?.kind ?? null
    const runMessages = visibleRows.slice(runStart, runEnd + 1).map((entry) => entry.msg)
    const canShowGroupCopy =
      runMessages.length > 0 &&
      runMessages.every((message) => !message.streaming) &&
      (nextVisibleKind === 'user' ||
        (!nextVisibleRow && !isThinking))

    for (let index = runStart; index <= runEnd; index += 1) {
      const assistantRow = visibleRows[index]
      items.push({
        id: assistantRow.id,
        kind: assistantRow.kind,
        estimatedHeight: estimateRowHeight(assistantRow.msg, assistantRow.kind),
        mergeWithPreviousAssistant: index > runStart,
        showAssistantGroupCopy: canShowGroupCopy && index === runEnd,
        assistantGroupMessageIds:
          canShowGroupCopy && index === runEnd
            ? assistantGroupMessageIds
            : [],
      })
    }

    visibleIndex += 1
  }

  return items
}
