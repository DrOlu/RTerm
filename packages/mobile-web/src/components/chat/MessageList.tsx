import React from 'react'
import { CornerUpLeft } from 'lucide-react'
import { formatClock, messageDetail, messageTypeTitle } from '../../format'
import { type AgentTimelineItem, type ChatTimelineItem } from '../../lib/chat-timeline'
import { normalizeDisplayText, trimOuterBlankLines } from '../../session-store'
import type { ChatMessage } from '../../types'
import { MarkdownContent } from '../common/MarkdownContent'
import { MentionContent } from '../common/MentionContent'

interface MessageListProps {
  items: ChatTimelineItem[]
  onAskDecision: (message: ChatMessage, decision: 'allow' | 'deny') => void
  onOpenDetail: (turnId: string) => void
  onRollback: (message: ChatMessage) => void
  rollbackDisabled: boolean
  listRef: React.RefObject<HTMLDivElement>
}

const UserBubble: React.FC<{
  message: ChatMessage
  onRollback: (message: ChatMessage) => void
  rollbackDisabled: boolean
}> = ({ message, onRollback, rollbackDisabled }) => {
  const displayText = trimOuterBlankLines(normalizeDisplayText(String(message.content || '')))
  if (!displayText.trim()) return null
  const canRollback = !!message.backendMessageId && !message.streaming && !rollbackDisabled

  return (
    <article className="bubble-row user">
      <div className="bubble user">
        <p>
          <MentionContent text={displayText} />
        </p>
        <footer>
          <span>{formatClock(message.timestamp)}</span>
          {message.streaming ? <span className="streaming">streaming</span> : null}
          <button
            type="button"
            className="bubble-rollback-btn"
            onClick={() => onRollback(message)}
            disabled={!canRollback}
            title="Rollback and re-edit"
          >
            <CornerUpLeft size={14} />
            <span>Rollback</span>
          </button>
        </footer>
      </div>
    </article>
  )
}

const AgentTurnBubble: React.FC<{
  item: AgentTimelineItem
  isLastItem: boolean
  onAskDecision: (message: ChatMessage, decision: 'allow' | 'deny') => void
  onOpenDetail: (turnId: string) => void
}> = ({ item, isLastItem, onAskDecision, onOpenDetail }) => {
  const message = item.latestMessage
  const messageTitle = messageTypeTitle(message)
  const preview = trimOuterBlankLines(messageDetail(message))
  const isText = message.type === 'text'
  const isAsk = message.type === 'ask'
  const isToolLike =
    message.type === 'command' ||
    message.type === 'tool_call' ||
    message.type === 'file_edit' ||
    message.type === 'sub_tool' ||
    message.type === 'reasoning'
  const decision = message.metadata?.decision
  const showDecisionButtons = isAsk && decision !== 'allow' && decision !== 'deny'
  const markdownPreview = trimOuterBlankLines(normalizeDisplayText(message.content || ''))
  const textPreview = markdownPreview || (item.streaming ? '...' : '')
  const eventPreview = preview || (item.streaming ? '...' : '')
  const shouldClampTextPreview = item.streaming || !isLastItem

  return (
    <article className="bubble-row assistant">
      <div className="bubble assistant agent-turn">
        {isText ? (
          <MarkdownContent
            className={`bubble-markdown ${shouldClampTextPreview ? 'streaming-clamped' : ''} ${
              markdownPreview ? '' : 'placeholder'
            }`}
            content={textPreview}
          />
        ) : (
          <div className="agent-event-preview">
            <div className="agent-event-title">{messageTitle}</div>
            {eventPreview ? <pre className={`agent-event-body ${isToolLike ? 'tool-fixed' : ''}`}>{eventPreview}</pre> : null}
          </div>
        )}

        {showDecisionButtons ? (
          <div className="decision-actions">
            <button type="button" className="accent-btn" onClick={() => onAskDecision(message, 'allow')}>
              Allow
            </button>
            <button type="button" className="danger-btn" onClick={() => onAskDecision(message, 'deny')}>
              Deny
            </button>
          </div>
        ) : null}

        {isAsk && decision ? <p className="decision-result">Decision: {decision}</p> : null}

        <footer>
          <span>{formatClock(message.timestamp || item.startedAt)}</span>
          {item.streaming ? <span className="streaming">streaming</span> : null}
          <button type="button" className="bubble-detail-btn" onClick={() => onOpenDetail(item.id)}>
            Details
          </button>
        </footer>
      </div>
    </article>
  )
}

export const MessageList: React.FC<MessageListProps> = ({
  items,
  onAskDecision,
  onOpenDetail,
  onRollback,
  rollbackDisabled,
  listRef
}) => {
  return (
    <main className="message-list" ref={listRef}>
      {items.length === 0 ? (
        <div className="empty-state">
          <p>No messages yet.</p>
          <p>Send a prompt to track this session progress.</p>
        </div>
      ) : (
        items.map((item) => {
          if (item.kind === 'user') {
            return (
              <UserBubble
                key={item.id}
                message={item.message}
                onRollback={onRollback}
                rollbackDisabled={rollbackDisabled}
              />
            )
          }
          return (
            <AgentTurnBubble
              key={item.id}
              item={item}
              isLastItem={item.id === items[items.length - 1]?.id}
              onAskDecision={onAskDecision}
              onOpenDetail={onOpenDetail}
            />
          )
        })
      )}
    </main>
  )
}
