/**
 * userMessageNav — pure helpers for navigating to USER queries in a chat
 * session (Prev user / Next user / Latest). Extracted so it's fully
 * unit-testable without React.
 *
 * The model: user messages form an ordered list of "anchors" (oldest → newest).
 * Prev/Next walk that list and WRAP at the ends so the buttons can stay enabled
 * in every session (same always-on feel as Top / Bottom). The cursor is a
 * message id so it survives re-renders.
 *
 * Scroll alignment is "pin the user query to the top of the pane" — never
 * vertically center it. Centering a short user bubble next to a long assistant
 * reply makes the jump look like it landed on the assistant.
 */

export interface UserMessageAnchor {
  id: string
  /** 1-based position among user messages (oldest first). */
  index: number
  total: number
}

/** Pixels of breathing room above a jumped-to user query. */
export const USER_NAV_TOP_PADDING_PX = 8

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
 *
 * - previous: user message before `currentId`. From nothing → latest. From first → wraps to latest.
 * - next: user message after `currentId`. From nothing → first. From latest → wraps to first.
 * - latest: most recent user message.
 *
 * Returns null only when there are no user messages at all.
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
    if (cur === null) return anchorFor(anchors, anchors[anchors.length - 1])
    const targetIdx = (cur.index - 2 + anchors.length) % anchors.length
    return anchorFor(anchors, anchors[targetIdx])
  }
  // next — wrap; from nothing start at the first user query
  if (cur === null) return anchorFor(anchors, anchors[0])
  const targetIdx = cur.index % anchors.length
  return anchorFor(anchors, anchors[targetIdx])
}

/**
 * Scroll offset that pins a user-query row to the TOP of the viewport
 * (plus a small padding). Never centers — a centered short query next to a
 * long assistant reply looks like the jump landed on the assistant.
 */
export function userNavScrollTop(targetTop: number, paddingPx: number = USER_NAV_TOP_PADDING_PX): number {
  const top = Number.isFinite(targetTop) ? targetTop : 0
  const pad = Number.isFinite(paddingPx) ? paddingPx : 0
  return Math.max(0, top - Math.max(0, pad))
}
