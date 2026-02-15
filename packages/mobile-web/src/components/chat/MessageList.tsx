import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { formatClock, messageDetail, messageTypeTitle } from '../../format'
import { type AgentTimelineItem, type ChatTimelineItem } from '../../lib/chat-timeline'
import { normalizeDisplayText, trimOuterBlankLines } from '../../session-store'
import type { ChatMessage } from '../../types'
import { MentionContent } from '../common/MentionContent'

interface MessageListProps {
  items: ChatTimelineItem[]
  onAskDecision: (message: ChatMessage, decision: 'allow' | 'deny') => void
  onOpenDetail: (turnId: string) => void
  listRef: React.RefObject<HTMLDivElement>
}

const UserBubble: React.FC<{ message: ChatMessage }> = ({ message }) => {
  const displayText = trimOuterBlankLines(normalizeDisplayText(String(message.content || '')))
  if (!displayText.trim()) return null

  return (
    <article className="bubble-row user">
      <div className="bubble user">
        <p>
          <MentionContent text={displayText} />
        </p>
        <footer>
          <span>{formatClock(message.timestamp)}</span>
          {message.streaming ? <span className="streaming">streaming</span> : null}
        </footer>
      </div>
    </article>
  )
}

const AgentTurnBubble: React.FC<{
  item: AgentTimelineItem
  onAskDecision: (message: ChatMessage, decision: 'allow' | 'deny') => void
  onOpenDetail: (turnId: string) => void
}> = ({ item, onAskDecision, onOpenDetail }) => {
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

  return (
    <article className="bubble-row assistant">
      <div className="bubble assistant agent-turn">
        {isText ? (
          <div className="bubble-markdown">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />
              }}
            >
              {markdownPreview}
            </ReactMarkdown>
          </div>
        ) : (
          <div className="agent-event-preview">
            <div className="agent-event-title">{messageTitle}</div>
            {preview ? (
              <pre className={`agent-event-body ${isToolLike ? 'tool-fixed' : ''}`}>{preview}</pre>
            ) : null}
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

export const MessageList: React.FC<MessageListProps> = ({ items, onAskDecision, onOpenDetail, listRef }) => {
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
            return <UserBubble key={item.id} message={item.message} />
          }
          return (
            <AgentTurnBubble key={item.id} item={item} onAskDecision={onAskDecision} onOpenDetail={onOpenDetail} />
          )
        })
      )}
    </main>
  )
}
