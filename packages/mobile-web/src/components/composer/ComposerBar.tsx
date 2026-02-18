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
  mentionOptions,
  onPickMention
}) => {
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null)

  React.useEffect(() => {
    const input = textareaRef.current
    if (!input) return
    input.style.height = '0px'
    const next = Math.min(Math.max(input.scrollHeight, 36), 160)
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
      <MentionSuggestions options={mentionOptions} onPick={onPickMention} />

      <div className="composer-textarea-row">
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
          }}
          placeholder="Message... use @ for terminal/skill"
          autoCorrect="off"
          autoCapitalize="sentences"
        />
      </div>

      <div className="composer-bottom-row">
        <div className="composer-row-left">
          <div className={`composer-profile-selector ${profileLocked ? 'locked' : ''}`}>
            {profileLocked ? <Lock size={10} /> : null}
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
          {tokenUsagePercent !== null ? <span className="composer-token-label">{tokenUsagePercent}%</span> : null}
        </div>

        <div className="composer-row-right">
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
