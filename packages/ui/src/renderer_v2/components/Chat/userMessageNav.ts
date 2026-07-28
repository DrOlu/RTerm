/**
 * userMessageNav — pure helpers for navigating to user messages in a chat
 * session (the "previous user message" / "next user message" / "jump to latest"
 * navigation). Extracted so it's fully unit-testable without React.
 *
 * The model: user messages form an ordered list of "anchors". A cursor points
 * at one anchor (or none). "Previous" moves the cursor up (older), "next" moves
 * it down (newer), and "latest" jumps to the most recent user message. The
 * cursor is described by the message id, so it survives re-renders.
 */

export interface UserMessageAnchor {
  id: string
  /** 1-based position among user messages (oldest first). */
  index: number
  total: number
}

/** The ordered ids of user messages (oldest → newest) for a session. */
export function userMessageIds(
  messageIds: readonly string[],
  roleOf: (id: string) => string | undefined,
): string[] {
  const out: string[] = []
  for (const id of messageIds) {
    if (roleOf(id) === 'user') out.push(id)
  }
  return out
}

/** Resolve the anchor (id + 1-based index + total) for a message id, if it's a user message. */
export function anchorFor(
  anchors: readonly string[],
  messageId: string | null | undefined,
): UserMessageAnchor | null {
  if (!messageId) return null
  const idx = anchors.indexOf(messageId)
  if (idx < 0) return null
  return { id: messageId, index: idx + 1, total: anchors.length }
}

/**
 * Compute the next navigation target.
 * direction 'previous' → the user message before `currentId` (or the latest if none).
 * direction 'next' → the user message after `currentId` (or null if already at latest).
 * direction 'latest' → the most recent user message.
 * Returns the target anchor, or null when there is nothing to go to.
 */
export function resolveUserMessageNavTarget(
  anchors: readonly string[],
  currentId: string | null | undefined,
  direction: 'previous' | 'next' | 'latest',
): UserMessageAnchor | null {
  if (anchors.length === 0) return null
  if (direction === 'latest') {
    return anchorFor(anchors, anchors[anchors.length - 1])
  }
  const cur = anchorFor(anchors, currentId)
  if (direction === 'previous') {
    // From nothing → latest; from first → stay at first (no wrap).
    const targetIdx = cur === null ? anchors.length - 1 : Math.max(0, cur.index - 2)
    return anchorFor(anchors, anchors[targetIdx])
  }
  // next
  if (cur === null) return null // nothing selected → "next" is meaningless; use latest instead
  if (cur.index >= anchors.length) return null // already at latest
  return anchorFor(anchors, anchors[cur.index])
}
