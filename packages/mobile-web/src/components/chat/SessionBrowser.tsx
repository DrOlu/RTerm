import React from 'react'
import { Plus, Search } from 'lucide-react'
import { formatRelativeTime } from '../../format'

export interface SessionBrowserItem {
  id: string
  title: string
  updatedAt: number
  preview: string
  messagesCount: number
  isRunning: boolean
}

interface SessionBrowserProps {
  activeSessionId: string | null
  items: SessionBrowserItem[]
  searchQuery: string
  onSearchChange: (value: string) => void
  onCreateSession: () => void
  onOpenSession: (sessionId: string) => void
}

function titleInitial(title: string): string {
  const normalized = String(title || '').trim()
  if (!normalized) return '#'
  return normalized.slice(0, 1).toUpperCase()
}

export const SessionBrowser: React.FC<SessionBrowserProps> = ({
  activeSessionId,
  items,
  searchQuery,
  onSearchChange,
  onCreateSession,
  onOpenSession
}) => {
  return (
    <section className="session-browser">
      <div className="session-browser-top">
        <label className="session-search">
          <Search size={14} />
          <input
            value={searchQuery}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search chats"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </label>
        <button
          type="button"
          className="session-create-btn"
          aria-label="Create new chat"
          title="Create new chat"
          onClick={onCreateSession}
        >
          <Plus size={15} />
        </button>
      </div>

      {items.length === 0 ? (
        <p className="panel-empty">No chat sessions found.</p>
      ) : (
        <div className="session-browser-list">
          {items.map((item) => {
            const isActive = item.id === activeSessionId
            return (
              <button
                key={item.id}
                type="button"
                className={`session-chat-item ${isActive ? 'active' : ''}`}
                onClick={() => onOpenSession(item.id)}
              >
                <span className="session-avatar">{titleInitial(item.title)}</span>
                <div className="session-chat-main">
                  <div className="session-chat-head">
                    <h3>{item.title}</h3>
                    <span>{formatRelativeTime(item.updatedAt)}</span>
                  </div>
                  <p>{item.preview || 'No updates yet.'}</p>
                  <div className="session-chat-meta">
                    <span>{item.messagesCount} messages</span>
                    <span className={item.isRunning ? 'busy' : 'idle'}>{item.isRunning ? 'RUNNING' : 'IDLE'}</span>
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      )}
    </section>
  )
}
