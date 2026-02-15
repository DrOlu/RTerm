import React from 'react'
import { Lock, SendHorizontal, Square } from 'lucide-react'
import { consumeMentionBackspace, type MentionOption } from '../../lib/mentions'
import type { GatewayProfileSummary } from '../../types'
import { MentionSuggestions } from './MentionSuggestions'

interface ComposerBarProps {
  value: string
  cursor: number
  onChange: (value: string, cursor: number) => void
  onCursorChange: (cursor: number) => void
  onSend: () => void
  onStop: () => void
  canSend: boolean
  isRunning: boolean
  profiles: GatewayProfileSummary[]
  activeProfileId: string
  lockedProfileId: string | null
  tokenUsagePercent: number | null
  onUpdateProfile: (profileId: string) => void
  sessionHint: string
  mentionOptions: MentionOption[]
  onPickMention: (option: MentionOption) => void
}

export const ComposerBar: React.FC<ComposerBarProps> = ({
  value,
  cursor,
  onChange,
  onCursorChange,
  onSend,
  onStop,
  canSend,
  isRunning,
  profiles,
  activeProfileId,
  lockedProfileId,
  tokenUsagePercent,
  onUpdateProfile,
  sessionHint,
  mentionOptions,
  onPickMention
}) => {
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null)

  React.useEffect(() => {
    const input = textareaRef.current
    if (!input) return
    input.style.height = '0px'
    const next = Math.min(Math.max(input.scrollHeight, 36), 128)
    input.style.height = `${next}px`
  }, [value])

  React.useEffect(() => {
    const input = textareaRef.current
    if (!input) return
    if (document.activeElement !== input) return
    if (input.selectionStart === cursor && input.selectionEnd === cursor) return
    input.setSelectionRange(cursor, cursor)
  }, [cursor, value])

  const handleSend = React.useCallback(() => {
    onSend()
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
    })
  }, [onSend])

  const profileLocked = Boolean(isRunning && lockedProfileId)
  const profileValue = lockedProfileId || activeProfileId || profiles[0]?.id || ''

  return (
    <footer className="composer-modern">
      <div className="composer-status-row">
        <span className="composer-session-hint">{sessionHint}</span>
        <div className="composer-status-right">
          {tokenUsagePercent !== null ? <span className="composer-token-mini">{tokenUsagePercent}%</span> : null}
          <span
            className={`composer-run-indicator ${isRunning ? 'running' : 'idle'}`}
            aria-label={isRunning ? 'Running' : 'Idle'}
            title={isRunning ? 'Running' : 'Idle'}
          ></span>
        </div>
      </div>

      <div className="composer-input-shell">
        <MentionSuggestions options={mentionOptions} onPick={onPickMention} />

        <div className={`composer-profile-mini ${profileLocked ? 'locked' : ''}`}>
          <span className="composer-profile-prefix">
            {profileLocked ? <Lock size={10} /> : null}
            <span>Model</span>
          </span>
          <select
            value={profileValue}
            disabled={profileLocked || profiles.length === 0}
            onChange={(event) => onUpdateProfile(event.target.value)}
          >
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </select>
        </div>

        <textarea
          ref={textareaRef}
          value={value}
          rows={1}
          onChange={(event) => onChange(event.target.value, event.target.selectionStart || 0)}
          onSelect={(event) => onCursorChange(event.currentTarget.selectionStart || 0)}
          onClick={(event) => onCursorChange(event.currentTarget.selectionStart || 0)}
          onKeyDown={(event) => {
            if (event.key === 'Backspace') {
              const target = event.currentTarget
              const start = target.selectionStart || 0
              const end = target.selectionEnd || 0
              const collapsedDelete = consumeMentionBackspace(value, start, end)
              if (collapsedDelete) {
                event.preventDefault()
                onChange(collapsedDelete.value, collapsedDelete.cursor)
                return
              }
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              handleSend()
            }
          }}
          placeholder="Message... use @ for terminal/skill"
          autoCorrect="off"
          autoCapitalize="sentences"
        />

        <div className="composer-actions">
          <button
            type="button"
            className="composer-icon-button stop"
            onClick={onStop}
            disabled={!isRunning}
            aria-label="Stop run"
            title="Stop run"
          >
            <Square size={12} />
          </button>
          <button
            type="button"
            className="composer-icon-button send"
            onClick={handleSend}
            disabled={!canSend}
            aria-label="Send message"
            title="Send"
          >
            <SendHorizontal size={14} />
          </button>
        </div>
      </div>
    </footer>
  )
}
