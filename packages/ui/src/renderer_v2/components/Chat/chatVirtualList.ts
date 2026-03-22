import type { ChatRenderItem } from './chatRenderModel'

export const CHAT_MESSAGE_LIST_BOTTOM_PADDING = 20
export const DEFAULT_CHAT_MESSAGE_ROW_HEIGHT = 140
export const DEFAULT_CHAT_MESSAGE_OVERSCAN_PX = 600

export interface ChatVirtualLayout {
  offsets: number[]
  heights: number[]
  totalHeight: number
}

export interface ChatVirtualRange {
  startIndex: number
  endIndex: number
}

export interface ChatIndexedRenderItem {
  item: ChatRenderItem
  index: number
}

export type ChatOffscreenMeasurementRetentionMode =
  | 'next-layout'
  | 'until-done'

export type ChatOffscreenMeasurementRetentionState = Record<
  string,
  ChatOffscreenMeasurementRetentionMode
>

export interface ChatScrollAnchorAdjustmentInput {
  layout: ChatVirtualLayout
  itemIndex: number
  nextHeight: number
  scrollTop: number
  autoScrollEnabled: boolean
}

const normalizeViewportWidth = (
  width: number | null | undefined,
): number | null =>
  Number.isFinite(width) && typeof width === 'number' && width > 0
    ? Math.round(width)
    : null

const normalizeRowHeight = (height: number | undefined): number =>
  Number.isFinite(height) && typeof height === 'number' && height > 24
    ? Math.ceil(height)
    : DEFAULT_CHAT_MESSAGE_ROW_HEIGHT

export const shouldInvalidateChatMeasuredHeights = (
  previousViewportWidth: number | null,
  nextViewportWidth: number | null | undefined,
): boolean => {
  const normalizedPreviousWidth = normalizeViewportWidth(previousViewportWidth)
  const normalizedNextWidth = normalizeViewportWidth(nextViewportWidth)
  if (normalizedPreviousWidth === null || normalizedNextWidth === null) {
    return false
  }

  return normalizedPreviousWidth !== normalizedNextWidth
}

export const buildChatVirtualLayout = (
  items: readonly ChatRenderItem[],
  measuredHeights: ReadonlyMap<string, number>,
  options?: {
    bottomPadding?: number
  },
): ChatVirtualLayout => {
  const offsets: number[] = []
  const heights: number[] = []
  const bottomPadding =
    options?.bottomPadding ?? CHAT_MESSAGE_LIST_BOTTOM_PADDING
  let cursor = 0

  items.forEach((item) => {
    offsets.push(cursor)
    const nextHeight = normalizeRowHeight(
      measuredHeights.get(item.id) ?? item.estimatedHeight,
    )
    heights.push(nextHeight)
    cursor += nextHeight
  })

  return {
    offsets,
    heights,
    totalHeight: cursor + bottomPadding,
  }
}

const findFirstIndexWithBottomAfter = (
  layout: ChatVirtualLayout,
  boundary: number,
): number => {
  let low = 0
  let high = layout.heights.length

  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    const bottom = layout.offsets[mid] + layout.heights[mid]
    if (bottom <= boundary) {
      low = mid + 1
    } else {
      high = mid
    }
  }

  return low
}

const findFirstIndexStartingAfter = (
  layout: ChatVirtualLayout,
  boundary: number,
): number => {
  let low = 0
  let high = layout.offsets.length

  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (layout.offsets[mid] < boundary) {
      low = mid + 1
    } else {
      high = mid
    }
  }

  return low
}

export const resolveChatVirtualRange = (
  layout: ChatVirtualLayout,
  scrollTop: number,
  viewportHeight: number,
  overscanPx: number = DEFAULT_CHAT_MESSAGE_OVERSCAN_PX,
): ChatVirtualRange => {
  if (layout.heights.length === 0 || viewportHeight <= 0) {
    return {
      startIndex: 0,
      endIndex: 0,
    }
  }

  const startBoundary = Math.max(0, scrollTop - overscanPx)
  const endBoundary = Math.max(0, scrollTop + viewportHeight + overscanPx)
  const startIndex = Math.min(
    layout.heights.length - 1,
    findFirstIndexWithBottomAfter(layout, startBoundary),
  )
  const endIndex = Math.max(
    startIndex + 1,
    Math.min(
      layout.heights.length,
      findFirstIndexStartingAfter(layout, endBoundary),
    ),
  )

  return {
    startIndex,
    endIndex,
  }
}

export const resolveChatOffscreenStreamingItems = (
  items: readonly ChatIndexedRenderItem[],
  visibleRange: ChatVirtualRange,
): ChatRenderItem[] => {
  if (items.length === 0) {
    return []
  }

  return items.reduce<ChatRenderItem[]>((result, entry) => {
    const isVisible =
      entry.index >= visibleRange.startIndex &&
      entry.index < visibleRange.endIndex
    if (isVisible) {
      return result
    }

    result.push(entry.item)
    return result
  }, [])
}

const hasChatRenderItemLayoutChange = (
  previousItem: ChatRenderItem | undefined,
  nextItem: ChatRenderItem,
): boolean => {
  if (!previousItem) {
    return false
  }

  return (
    previousItem.kind !== nextItem.kind ||
    previousItem.estimatedHeight !== nextItem.estimatedHeight ||
    previousItem.mergeWithPreviousAssistant !==
      nextItem.mergeWithPreviousAssistant ||
    previousItem.showAssistantGroupCopy !== nextItem.showAssistantGroupCopy
  )
}

export const resolveChatOffscreenLayoutChangedItems = (
  items: readonly ChatRenderItem[],
  previousItemsById: ReadonlyMap<string, ChatRenderItem>,
  visibleRange: ChatVirtualRange,
): ChatRenderItem[] => {
  if (items.length === 0) {
    return []
  }

  return items.reduce<ChatRenderItem[]>((result, item, index) => {
    const isVisible =
      index >= visibleRange.startIndex && index < visibleRange.endIndex
    if (isVisible) {
      return result
    }

    if (hasChatRenderItemLayoutChange(previousItemsById.get(item.id), item)) {
      result.push(item)
    }
    return result
  }, [])
}

export interface ResolveNextChatOffscreenMeasurementRetentionStateInput {
  currentState: ChatOffscreenMeasurementRetentionState
  currentOffscreenStreamingItems: readonly ChatRenderItem[]
  renderItemIndexById: ReadonlyMap<string, number>
  visibleRange: ChatVirtualRange
  tailRetentionItemId: string | null
  thinking: boolean
}

export const resolveNextChatOffscreenMeasurementRetentionState = ({
  currentState,
  currentOffscreenStreamingItems,
  renderItemIndexById,
  visibleRange,
  tailRetentionItemId,
  thinking,
}: ResolveNextChatOffscreenMeasurementRetentionStateInput): ChatOffscreenMeasurementRetentionState => {
  const nextState: ChatOffscreenMeasurementRetentionState = {}
  const streamingIds = new Set(currentOffscreenStreamingItems.map((item) => item.id))

  currentOffscreenStreamingItems.forEach((item) => {
    nextState[item.id] =
      thinking && item.id === tailRetentionItemId
        ? 'until-done'
        : 'next-layout'
  })

  Object.entries(currentState).forEach(([itemId, mode]) => {
    if (streamingIds.has(itemId)) {
      return
    }

    const itemIndex = renderItemIndexById.get(itemId)
    const isVisible =
      typeof itemIndex === 'number' &&
      itemIndex >= visibleRange.startIndex &&
      itemIndex < visibleRange.endIndex
    if (typeof itemIndex !== 'number' || isVisible) {
      return
    }

    if (
      mode === 'until-done' &&
      thinking &&
      itemId === tailRetentionItemId
    ) {
      nextState[itemId] = 'until-done'
    }
  })

  const currentEntries = Object.entries(currentState)
  const nextEntries = Object.entries(nextState)
  if (currentEntries.length !== nextEntries.length) {
    return nextState
  }

  const changed = currentEntries.some(
    ([itemId, mode]) => nextState[itemId] !== mode,
  )
  return changed ? nextState : currentState
}

export const resolveChatScrollAnchorAdjustment = ({
  layout,
  itemIndex,
  nextHeight,
  scrollTop,
  autoScrollEnabled,
}: ChatScrollAnchorAdjustmentInput): number => {
  if (autoScrollEnabled) {
    return 0
  }
  if (
    itemIndex < 0 ||
    itemIndex >= layout.heights.length ||
    !Number.isFinite(scrollTop)
  ) {
    return 0
  }

  const currentHeight = layout.heights[itemIndex]
  const normalizedNextHeight = normalizeRowHeight(nextHeight)
  if (currentHeight === normalizedNextHeight) {
    return 0
  }

  const rowBottom = layout.offsets[itemIndex] + currentHeight
  if (rowBottom > scrollTop) {
    return 0
  }

  return normalizedNextHeight - currentHeight
}
