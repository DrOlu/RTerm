import { renderMentionText } from './MentionParser'

/**
 * Shared by:
 * 1) Chat panel tab title rendering (`components/Chat/ChatPanel.tsx`)
 * 2) Session title text normalization before display/search/rename
 */
export const CHAT_PANEL_SESSION_TITLE_CHAR_LIMIT = 10

const truncate = (text: string, limit: number): string => {
  if (!text) return 'Untitled'
  return text.length > limit ? `${text.slice(0, limit)}...` : text
}

const normalizeTitleText = (title: string): string => {
  const text = renderMentionText(title).trim()
  return text || 'Untitled'
}

export const formatChatPanelSessionTitle = (title: string): string => {
  return truncate(normalizeTitleText(title), CHAT_PANEL_SESSION_TITLE_CHAR_LIMIT)
}

export const normalizeSessionTitleText = (title: string): string => {
  return normalizeTitleText(title)
}
