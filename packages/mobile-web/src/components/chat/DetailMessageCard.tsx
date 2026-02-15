import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { clipMultiline, formatClock, messageDetail, messageTypeTitle } from '../../format'
import { isEmptyMessageContent, normalizeDisplayText, trimOuterBlankLines } from '../../session-store'
import type { ChatMessage } from '../../types'
import { MentionContent } from '../common/MentionContent'

interface DetailMessageCardProps {
  message: ChatMessage
  onAskDecision: (message: ChatMessage, decision: 'allow' | 'deny') => void
}

export const DetailMessageCard: React.FC<DetailMessageCardProps> = ({ message, onAskDecision }) => {
  const TOOL_PREVIEW_LINES = 8
  const TOOL_PREVIEW_CHARS = 420
  const [expanded, setExpanded] = React.useState(false)
  const isToolLikeMessage =
    message.type === 'command' ||
    message.type === 'tool_call' ||
    message.type === 'file_edit' ||
    message.type === 'sub_tool' ||
    message.type === 'reasoning'

  if (message.type === 'text') {
    const displayText = trimOuterBlankLines(normalizeDisplayText(message.content || ''))
    if (!displayText.trim()) return null

    return (
      <article className={`event-card detail-text ${message.role}`}>
        <header>
          <strong>{message.role === 'assistant' ? 'Assistant Text' : 'System Text'}</strong>
          <span>{formatClock(message.timestamp)}</span>
        </header>
        {message.role === 'assistant' ? (
          <div className="detail-markdown">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />
              }}
            >
              {displayText}
            </ReactMarkdown>
          </div>
        ) : (
          <p className="detail-text-body">
            <MentionContent text={displayText} />
          </p>
        )}
      </article>
    )
  }

  const title = messageTypeTitle(message)
  const detail = trimOuterBlankLines(messageDetail(message))
  if (!detail.trim() && isEmptyMessageContent(message) && message.type !== 'ask' && message.type !== 'command') {
    return null
  }

  const detailLines = detail.split('\n').length
  const showExpandToggle =
    isToolLikeMessage && (detailLines > TOOL_PREVIEW_LINES || detail.length > TOOL_PREVIEW_CHARS)
  const detailToRender =
    showExpandToggle && !expanded ? clipMultiline(detail, TOOL_PREVIEW_LINES, TOOL_PREVIEW_CHARS) : detail

  const decision = message.metadata?.decision
  const showDecisionButtons = message.type === 'ask' && decision !== 'allow' && decision !== 'deny'

  return (
    <article className={`event-card detail-card ${isToolLikeMessage ? 'tool-like' : message.type}`}>
      <header>
        <div className="event-title-group">
          {isToolLikeMessage ? <span className="event-chip">Tool</span> : null}
          <strong>{title}</strong>
        </div>
        <span>{formatClock(message.timestamp)}</span>
      </header>

      {detailToRender ? (
        <pre className={isToolLikeMessage ? `toolcall-detail ${showExpandToggle && !expanded ? 'is-collapsed' : ''}` : ''}>
          {detailToRender}
        </pre>
      ) : null}

      {showExpandToggle ? (
        <button type="button" className="event-expand-btn" onClick={() => setExpanded((previous) => !previous)}>
          {expanded ? 'Collapse' : 'Expand'}
        </button>
      ) : null}

      {message.type === 'error' && message.metadata?.details ? <pre>{message.metadata.details}</pre> : null}

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

      {message.type === 'ask' && decision ? <p className="decision-result">Decision: {decision}</p> : null}
    </article>
  )
}
