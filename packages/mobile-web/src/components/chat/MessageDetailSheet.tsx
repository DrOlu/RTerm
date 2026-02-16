import React from 'react'
import { ChevronLeft } from 'lucide-react'
import type { AgentTimelineItem } from '../../lib/chat-timeline'
import type { ChatMessage } from '../../types'
import { DetailMessageCard } from './DetailMessageCard'

const DETAIL_AUTO_SCROLL_THRESHOLD_PX = 48

function isDetailListNearBottom(element: HTMLElement): boolean {
  const remainingDistance = element.scrollHeight - element.scrollTop - element.clientHeight
  return remainingDistance <= DETAIL_AUTO_SCROLL_THRESHOLD_PX
}

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
  const detailListRef = React.useRef<HTMLElement>(null)
  const shouldStickDetailListToBottomRef = React.useRef(true)
  const detailUpdateSignature = React.useMemo(() => {
    return messages
      .map((message) => {
        const contentLength = String(message.content || '').length
        const outputLength = String(message.metadata?.output || '').length
        return `${message.id}:${message.streaming ? '1' : '0'}:${contentLength}:${outputLength}`
      })
      .join('|')
  }, [messages])

  React.useEffect(() => {
    if (!open) return
    const element = detailListRef.current
    if (!element) return

    const handleScroll = () => {
      shouldStickDetailListToBottomRef.current = isDetailListNearBottom(element)
    }
    handleScroll()
    element.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      element.removeEventListener('scroll', handleScroll)
    }
  }, [open, turn?.id])

  React.useEffect(() => {
    if (!open) return
    const element = detailListRef.current
    if (!element) return
    element.scrollTop = element.scrollHeight
    shouldStickDetailListToBottomRef.current = true
  }, [open, turn?.id])

  React.useEffect(() => {
    if (!open || !shouldStickDetailListToBottomRef.current) return
    const element = detailListRef.current
    if (!element) return
    element.scrollTop = element.scrollHeight
  }, [open, detailUpdateSignature])

  return (
    <aside className={`detail-screen ${open ? 'is-open' : ''}`} aria-hidden={!open}>
      <header className="detail-screen-header">
        <button type="button" className="top-back-btn" onClick={onClose} aria-label="Close detail">
          <ChevronLeft size={20} />
        </button>
        <h2>Message Detail</h2>
        <div style={{ width: 28 }} /> {/* Spacer to balance the header */}
      </header>

      <section className="detail-sheet-meta">
        <span>{messages.length} events</span>
      </section>

      <section className="detail-list" ref={detailListRef}>
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
