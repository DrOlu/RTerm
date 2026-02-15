import React from 'react'
import { X } from 'lucide-react'
import type { AgentTimelineItem } from '../../lib/chat-timeline'
import type { ChatMessage } from '../../types'
import { DetailMessageCard } from './DetailMessageCard'

interface MessageDetailSheetProps {
  open: boolean
  turn: AgentTimelineItem | null
  onClose: () => void
  onAskDecision: (message: ChatMessage, decision: 'allow' | 'deny') => void
}

export const MessageDetailSheet: React.FC<MessageDetailSheetProps> = ({
  open,
  turn,
  onClose,
  onAskDecision
}) => {
  const messages = turn?.detailMessages || []

  return (
    <aside className={`detail-screen ${open ? 'is-open' : ''}`} aria-hidden={!open}>
      <header className="detail-screen-header">
        <h2>Message Detail</h2>
        <button type="button" className="sheet-icon-btn" onClick={onClose} aria-label="Close detail">
          <X size={15} />
          <span className="sr-only">Close</span>
        </button>
      </header>

      <section className="detail-sheet-meta">
        <span>{messages.length} events</span>
      </section>

      <section className="detail-list">
        {messages.length === 0 ? (
          <p className="panel-empty">No detail messages for this turn.</p>
        ) : (
          messages.map((message) => (
            <DetailMessageCard key={message.id} message={message} onAskDecision={onAskDecision} />
          ))
        )}
      </section>
    </aside>
  )
}
