import React from 'react'
import { observer } from 'mobx-react-lite'
import { Check, Copy, CornerUpLeft } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { AppStore } from '../../stores/AppStore'
import type { ChatMessage } from '../../stores/ChatStore'
import { renderMentionContent } from '../../lib/MentionParser'
import { CommandBanner, ToolCallBanner, FileEditBanner, SubToolBanner, ReasoningBanner, CompactionBanner, AskBanner, AlertBanner } from './ChatBanner'

interface MessageRowProps {
  store: AppStore
  sessionId: string
  messageId: string
  onAskDecision: (messageId: string, decision: 'allow' | 'deny') => void
  onRollback: (msg: ChatMessage) => void
  askLabels: { allow: string; deny: string; allowed: string; denied: string }
  isThinking: boolean
}

const COPY_FEEDBACK_MS = 1200
const SPECIAL_ASSISTANT_TYPES: ReadonlySet<ChatMessage['type']> = new Set([
  'command',
  'tool_call',
  'file_edit',
  'sub_tool',
  'reasoning',
  'compaction',
  'ask',
  'alert',
  'error'
])

interface MessageSessionShape {
  messageIds: string[]
  messagesById: { get: (id: string) => ChatMessage | undefined }
}

interface VisibleRow {
  id: string
  index: number
  kind: 'assistant' | 'user'
  msg: ChatMessage
}

interface AssistantRun {
  start: number
  end: number
  isTail: boolean
  nextVisibleKind: RowDisplayKind | 'none'
  messages: ChatMessage[]
}

const extractNodeText = (node: React.ReactNode): string => {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (!node) return ''
  if (Array.isArray(node)) return node.map((item) => extractNodeText(item)).join('')
  if (React.isValidElement(node)) return extractNodeText(node.props.children)
  return ''
}

type RowDisplayKind = 'assistant' | 'user' | 'hidden'

const isCompletedWhitespaceAssistantText = (message: ChatMessage): boolean =>
  message.role === 'assistant' &&
  message.type === 'text' &&
  message.streaming !== true &&
  !/\S/.test(String(message.content || ''))

const getRowDisplayKind = (session: MessageSessionShape, messageId: string): RowDisplayKind => {
  const candidate = session.messagesById.get(messageId)
  if (!candidate) return 'hidden'
  if (candidate.type === 'tokens_count') return 'hidden'
  if (candidate.role === 'user') return 'user'
  if (isCompletedWhitespaceAssistantText(candidate)) return 'hidden'
  const isLastInSession = session.messageIds[session.messageIds.length - 1] === messageId
  const isRetryHint = candidate.type === 'alert' && candidate.metadata?.subToolLevel === 'info'
  if (isRetryHint && !isLastInSession) return 'hidden'
  if ((candidate.type === 'reasoning' || candidate.type === 'compaction') && !isLastInSession) return 'hidden'
  if (SPECIAL_ASSISTANT_TYPES.has(candidate.type)) return 'assistant'
  return candidate.role === 'assistant' ? 'assistant' : 'hidden'
}

const collectConnectedAssistantRun = (session: MessageSessionShape, messageId: string): AssistantRun | null => {
  const visibleRows: VisibleRow[] = session.messageIds
    .map((id, index) => {
      const msg = session.messagesById.get(id)
      if (!msg) return null
      const kind = getRowDisplayKind(session, id)
      if (kind === 'hidden') return null
      return { id, index, kind, msg }
    })
    .filter((item): item is VisibleRow => item !== null)

  const visibleIndex = visibleRows.findIndex((row) => row.id === messageId)
  if (visibleIndex < 0) return null
  const currentVisible = visibleRows[visibleIndex]
  if (!currentVisible || currentVisible.kind !== 'assistant') return null

  let startVisible = visibleIndex
  let endVisible = visibleIndex
  while (startVisible > 0 && visibleRows[startVisible - 1].kind === 'assistant') {
    startVisible -= 1
  }
  while (endVisible < visibleRows.length - 1 && visibleRows[endVisible + 1].kind === 'assistant') {
    endVisible += 1
  }

  const runRows = visibleRows.slice(startVisible, endVisible + 1)
  const nextVisible = visibleRows[endVisible + 1]

  return {
    start: runRows[0]?.index ?? currentVisible.index,
    end: runRows[runRows.length - 1]?.index ?? currentVisible.index,
    isTail: visibleIndex === endVisible,
    nextVisibleKind: nextVisible?.kind ?? 'none',
    messages: runRows.map((row) => row.msg)
  }
}

export const MessageRow: React.FC<MessageRowProps> = observer(({ 
  store,
  sessionId, 
  messageId, 
  onAskDecision, 
  onRollback,
  askLabels,
  isThinking 
}) => {
  const session = store.chat.sessions.find(s => s.id === sessionId)
  const msg = session?.messagesById.get(messageId)

  const [copiedKey, setCopiedKey] = React.useState<string | null>(null)
  const copyTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  React.useEffect(() => {
    return () => {
      if (copyTimerRef.current) {
        clearTimeout(copyTimerRef.current)
      }
    }
  }, [])

  const markCopied = React.useCallback((key: string) => {
    setCopiedKey(key)
    if (copyTimerRef.current) {
      clearTimeout(copyTimerRef.current)
    }
    copyTimerRef.current = setTimeout(() => {
      setCopiedKey((current) => (current === key ? null : current))
    }, COPY_FEEDBACK_MS)
  }, [])

  const assistantRun = session ? collectConnectedAssistantRun(session, messageId) : null
  const groupCopyKey = assistantRun ? `assistant-group:${assistantRun.start}:${assistantRun.end}` : ''
  const shouldShowGroupCopy =
    !!assistantRun &&
    assistantRun.isTail &&
    assistantRun.messages.length > 0 &&
    assistantRun.messages.every((item) => !item.streaming) &&
    (
      assistantRun.nextVisibleKind === 'user' ||
      (assistantRun.nextVisibleKind === 'none' && !isThinking)
    )

  const copyConnectedAssistantRun = React.useCallback(async () => {
    if (!assistantRun || assistantRun.messages.length === 0) return
    const messageIds = assistantRun.messages.map((item) => item.id)
    const formatted = await window.gyshell.agent.formatMessagesMarkdown(sessionId, messageIds)
    const payload = String(formatted || '').trim()
    if (!payload) return
    await navigator.clipboard.writeText(payload)
    markCopied(groupCopyKey)
  }, [assistantRun, groupCopyKey, markCopied, sessionId])

  const copyCodeBlock = React.useCallback(
    async (rawCode: string) => {
      const payload = String(rawCode || '').replace(/\n$/, '')
      if (!payload) return
      const feedbackKey = `code:${payload.length}:${payload.slice(0, 32)}`
      await navigator.clipboard.writeText(payload)
      markCopied(feedbackKey)
    },
    [markCopied]
  )

  if (!session || !msg) return null
  const isUser = msg.role === 'user'

  // Logic: If this is an 'alert' (retry hint), only show it if it's the absolute last message in the session
  // We check messageIds to see if this ID is the very last one.
  const isLastMessage = session.messageIds[session.messageIds.length - 1] === messageId
  const isRetryHint = msg.type === 'alert' && msg.metadata?.subToolLevel === 'info'
  
  if (isRetryHint && !isLastMessage) {
    return null
  }
  if ((msg.type === 'reasoning' || msg.type === 'compaction') && !isLastMessage) {
    return null
  }

  // Handle special message types
  if (msg.type === 'tokens_count') {
    return null
  }
  if (isCompletedWhitespaceAssistantText(msg)) {
    return null
  }
  const canRollback = isUser && !!msg.backendMessageId && !msg.streaming && !isThinking

  const renderAssistantRow = (children: React.ReactNode) => (
    <div className="message-row-container role-assistant">
      {children}
      {shouldShowGroupCopy && (
        <div className="message-assistant-group-actions">
          <button
            className="message-copy-btn message-assistant-copy-btn"
            title="Copy assistant message group"
            aria-label="Copy assistant message group"
            onClick={() => { void copyConnectedAssistantRun() }}
          >
            {copiedKey === groupCopyKey ? <Check size={12} /> : <Copy size={12} />}
          </button>
        </div>
      )}
    </div>
  )

  if (isUser) {
    const inputImages = msg.metadata?.inputImages || []
    return (
      <div className="message-row-container role-user">
        <div className="message-role-label user">USER</div>
        <div className="message-user-row">
          <div className={`message-text ${msg.role}`}>
            <div className="plain-text">
              {renderMentionContent(msg.content)}
              {msg.streaming && <span className="cursor-blink" />}
            </div>
            {inputImages.length > 0 && (
              <div className="message-user-images">
                {inputImages.map((image, index) => {
                  const src = String(image.previewDataUrl || '').trim()
                  return (
                    <div key={`${image.attachmentId || 'image'}-${index}`} className="message-user-image-item">
                      {src ? <img src={src} alt="Attached image" loading="lazy" /> : <div className="message-user-image-missing">IMG</div>}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
          <button
            className="message-rollback-btn"
            title="Rollback and re-edit"
            onClick={() => onRollback(msg)}
            disabled={!canRollback}
          >
            <CornerUpLeft size={14} />
          </button>
        </div>
      </div>
    )
  }

  if (msg.type === 'command') {
    return renderAssistantRow(<CommandBanner msg={msg} />)
  }
  if (msg.type === 'tool_call') {
    return renderAssistantRow(<ToolCallBanner msg={msg} />)
  }
  if (msg.type === 'file_edit') {
    return renderAssistantRow(<FileEditBanner msg={msg} />)
  }
  if (msg.type === 'sub_tool') {
    return renderAssistantRow(<SubToolBanner msg={msg} />)
  }
  if (msg.type === 'reasoning') {
    return renderAssistantRow(<ReasoningBanner msg={msg} />)
  }
  if (msg.type === 'compaction') {
    return renderAssistantRow(<CompactionBanner msg={msg} />)
  }
  if (msg.type === 'ask') {
    return renderAssistantRow(
      <AskBanner
        msg={msg}
        onDecision={(id, decision) => onAskDecision(id, decision)}
        labels={askLabels}
      />
    )
  }
  if (msg.type === 'alert' || msg.type === 'error') {
    return renderAssistantRow(
      <AlertBanner
        msg={msg}
        onRemove={() => store.chat.removeMessage(msg.id, sessionId)}
      />
    )
  }

  return renderAssistantRow(
    <>
      <div className="message-role-label assistant">ASSISTANT</div>
      <div className={`message-text ${msg.role}`}>
        <div className={msg.role === 'assistant' ? "markdown-body" : "plain-text"}>
          {msg.role === 'assistant' ? (
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                pre: ({ children, ...props }) => {
                  const codeText = extractNodeText(children)
                  const feedbackKey = `code:${codeText.length}:${codeText.slice(0, 32)}`
                  return (
                    <div className="markdown-pre-wrap">
                      <pre {...props}>{children}</pre>
                      <button
                        className="message-copy-btn markdown-pre-copy-btn"
                        title="Copy code"
                        aria-label="Copy code"
                        onClick={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          void copyCodeBlock(codeText)
                        }}
                      >
                        {copiedKey === feedbackKey ? <Check size={12} /> : <Copy size={12} />}
                      </button>
                    </div>
                  )
                },
                a: ({ node, ...props }) => (
                  <a {...props} target="_blank" rel="noopener noreferrer" />
                )
              }}
            >
              {msg.content}
            </ReactMarkdown>
          ) : (
            msg.content
          )}
          {msg.streaming && <span className="cursor-blink" />}
        </div>
      </div>
    </>
  )
})
