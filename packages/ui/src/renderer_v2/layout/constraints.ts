import {
  CHAT_GRID_TOTAL_ROWS,
  CHAT_MIN_GRID_ROWS,
  MAX_LAYOUT_PANELS,
  MAX_LAYOUT_SPLIT_CHILDREN,
  TECHNICAL_MIN_PANEL_SIZE_PX,
  type DropDirection,
  type LayoutNode,
  type LayoutRect,
  type LayoutSplitNode,
  type LayoutTree,
  type LayoutViewport,
  type NodeMinSize,
  type PanelKind
} from './types'
import { getPanelCount, normalizeSizes } from './tree'

const CHAT_FOOTER_HORIZONTAL_PADDING_PX = 24
const CHAT_FOOTER_PROFILE_SELECTOR_WIDTH_PX = 160
const CHAT_FOOTER_GROUP_GAP_PX = 8
const CHAT_FOOTER_QUEUE_BUTTON_WIDTH_PX = 28
const CHAT_FOOTER_ACTIONS_GAP_PX = 8
const CHAT_FOOTER_RUNTIME_ACTIONS_WIDTH_PX = 63
const CHAT_PANEL_BORDER_WIDTH_PX = 1

export const CHAT_PANEL_MIN_WIDTH_PX =
  CHAT_FOOTER_HORIZONTAL_PADDING_PX +
  CHAT_FOOTER_PROFILE_SELECTOR_WIDTH_PX +
  CHAT_FOOTER_GROUP_GAP_PX +
  CHAT_FOOTER_QUEUE_BUTTON_WIDTH_PX +
  CHAT_FOOTER_ACTIONS_GAP_PX +
  CHAT_FOOTER_RUNTIME_ACTIONS_WIDTH_PX +
  CHAT_PANEL_BORDER_WIDTH_PX

const PANEL_MIN_WIDTH_PX: Record<PanelKind, number> = {
  chat: CHAT_PANEL_MIN_WIDTH_PX,
  terminal: 160,
  filesystem: 160,
  fileEditor: 160,
  monitor: 170
}

const PANEL_MIN_HEIGHT_PX: Record<Exclude<PanelKind, 'chat'>, number> = {
  terminal: 90,
  filesystem: 90,
  fileEditor: 90,
  monitor: 120
}

const MIN_SIZE_PERCENTAGE_EPSILON = 0.000001

export interface LayoutGeometry {
  nodeRects: Record<string, LayoutRect>
  panelRects: Record<string, LayoutRect>
}

const cloneRect = (rect: LayoutRect): LayoutRect => ({
  left: rect.left,
  top: rect.top,
  width: rect.width,
  height: rect.height
})

export const getChatMinHeightPx = (viewportHeight: number): number => {
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) {
    return 100
  }
  const gridBased = Math.floor((viewportHeight * CHAT_MIN_GRID_ROWS) / CHAT_GRID_TOTAL_ROWS)
  return Math.max(100, gridBased)
}

export const getPanelMinWidthPx = (kind: PanelKind): number => {
  const configuredMinWidth = PANEL_MIN_WIDTH_PX[kind]
  return Math.max(TECHNICAL_MIN_PANEL_SIZE_PX, configuredMinWidth)
}

export const getPanelMinHeightPx = (kind: PanelKind, viewportHeight: number): number => {
  if (kind === 'chat') {
    return getChatMinHeightPx(viewportHeight)
  }
  return Math.max(TECHNICAL_MIN_PANEL_SIZE_PX, PANEL_MIN_HEIGHT_PX[kind])
}

export const getPanelMinSize = (kind: PanelKind, viewportHeight: number): NodeMinSize => {
  return {
    minWidthPx: getPanelMinWidthPx(kind),
    minHeightPx: getPanelMinHeightPx(kind, viewportHeight)
  }
}

export const computeNodeMinSize = (node: LayoutNode, viewportHeight: number): NodeMinSize => {
  if (node.type === 'panel') {
    return getPanelMinSize(node.panel.kind, viewportHeight)
  }

  const childrenMin = node.children.map((child) => computeNodeMinSize(child, viewportHeight))
  if (node.direction === 'horizontal') {
    return {
      minWidthPx: childrenMin.reduce((sum, child) => sum + child.minWidthPx, 0),
      minHeightPx: childrenMin.reduce((max, child) => Math.max(max, child.minHeightPx), 0)
    }
  }

  return {
    minWidthPx: childrenMin.reduce((max, child) => Math.max(max, child.minWidthPx), 0),
    minHeightPx: childrenMin.reduce((sum, child) => sum + child.minHeightPx, 0)
  }
}

const computeNodeRectsInner = (
  node: LayoutNode,
  rect: LayoutRect,
  nodeRects: Record<string, LayoutRect>,
  panelRects: Record<string, LayoutRect>
): void => {
  nodeRects[node.id] = cloneRect(rect)

  if (node.type === 'panel') {
    panelRects[node.panel.id] = cloneRect(rect)
    return
  }

  const sizes = normalizeSizes(node.sizes, node.children.length)
  const horizontal = node.direction === 'horizontal'
  let cursor = horizontal ? rect.left : rect.top

  node.children.forEach((child, index) => {
    const percentage = sizes[index] ?? 0
    const span = ((horizontal ? rect.width : rect.height) * percentage) / 100
    const childRect: LayoutRect = horizontal
      ? {
          left: cursor,
          top: rect.top,
          width: span,
          height: rect.height
        }
      : {
          left: rect.left,
          top: cursor,
          width: rect.width,
          height: span
        }

    computeNodeRectsInner(child, childRect, nodeRects, panelRects)
    cursor += span
  })
}

export const computeLayoutGeometry = (tree: LayoutTree, viewport: LayoutViewport): LayoutGeometry => {
  const nodeRects: Record<string, LayoutRect> = {}
  const panelRects: Record<string, LayoutRect> = {}
  if (viewport.width <= 0 || viewport.height <= 0) {
    return { nodeRects, panelRects }
  }

  computeNodeRectsInner(
    tree.root,
    {
      left: 0,
      top: 0,
      width: viewport.width,
      height: viewport.height
    },
    nodeRects,
    panelRects
  )

  return {
    nodeRects,
    panelRects
  }
}

export interface LayoutValidationResult {
  valid: boolean
  reason?: string
}

export const validateLayoutTree = (tree: LayoutTree, viewport: LayoutViewport): LayoutValidationResult => {
  if (getPanelCount(tree) > MAX_LAYOUT_PANELS) {
    return {
      valid: false,
      reason: 'panel-count-limit'
    }
  }

  const splitOverflow = (() => {
    const stack: LayoutNode[] = [tree.root]
    while (stack.length > 0) {
      const current = stack.pop()
      if (!current || current.type !== 'split') continue
      if (current.children.length > MAX_LAYOUT_SPLIT_CHILDREN) {
        return current.id
      }
      current.children.forEach((child) => stack.push(child))
    }
    return null
  })()
  if (splitOverflow) {
    return {
      valid: false,
      reason: `split-children-limit:${splitOverflow}`
    }
  }

  if (!Number.isFinite(viewport.width) || !Number.isFinite(viewport.height) || viewport.width <= 0 || viewport.height <= 0) {
    return { valid: true }
  }

  const { panelRects } = computeLayoutGeometry(tree, viewport)
  const panels = Object.values(panelRects)
  if (panels.length === 0) {
    return {
      valid: false,
      reason: 'empty-layout'
    }
  }

  const panelNodes = new Map<string, PanelKind>()
  const collect = (node: LayoutNode): void => {
    if (node.type === 'panel') {
      panelNodes.set(node.panel.id, node.panel.kind)
      return
    }
    node.children.forEach((child) => collect(child))
  }
  collect(tree.root)

  for (const [panelId, rect] of Object.entries(panelRects)) {
    const kind = panelNodes.get(panelId)
    const minWidth = kind ? getPanelMinWidthPx(kind) : TECHNICAL_MIN_PANEL_SIZE_PX
    const minHeight = kind
      ? getPanelMinHeightPx(kind, viewport.height)
      : TECHNICAL_MIN_PANEL_SIZE_PX

    if (rect.width < minWidth) {
      return {
        valid: false,
        reason: `panel-width-limit:${panelId}`
      }
    }

    if (rect.height < minHeight) {
      return {
        valid: false,
        reason: kind === 'chat' ? `chat-height-limit:${panelId}` : `panel-height-limit:${panelId}`
      }
    }

    if (kind === 'chat') {
      continue
    }
  }

  return { valid: true }
}

export const computeChildMinSizePercentages = (
  splitNode: LayoutSplitNode,
  parentRect: LayoutRect,
  viewportHeight: number
): number[] => {
  if (splitNode.children.length === 0) return []

  const horizontal = splitNode.direction === 'horizontal'
  const axisSize = horizontal ? parentRect.width : parentRect.height
  if (axisSize <= 0) {
    return Array.from({ length: splitNode.children.length }, () => 0)
  }

  return splitNode.children.map((child) => {
    const childMin = computeNodeMinSize(child, viewportHeight)
    const minPx = horizontal ? childMin.minWidthPx : childMin.minHeightPx
    return Math.max(0, (minPx / axisSize) * 100)
  })
}

export const clampSplitSizesToChildMinSizePercentages = (
  sizes: number[],
  minPercentages: number[]
): number[] => {
  const count = minPercentages.length
  if (count <= 0) return []

  const normalized = normalizeSizes(sizes, count)
  const minimums = minPercentages.map((percentage) => {
    if (!Number.isFinite(percentage) || percentage <= 0) return 0
    return Math.min(100, percentage + MIN_SIZE_PERCENTAGE_EPSILON)
  })
  const minTotal = minimums.reduce((sum, percentage) => sum + percentage, 0)
  if (minTotal <= 0) return normalized

  if (minTotal >= 100) {
    return normalizeSizes(minimums, count)
  }

  const clamped = normalized.map((size, index) => Math.max(size, minimums[index] ?? 0))
  const clampedTotal = clamped.reduce((sum, size) => sum + size, 0)
  const overflow = clampedTotal - 100
  if (overflow <= 0) return clamped

  const flexibleAmounts = clamped.map((size, index) => Math.max(0, size - (minimums[index] ?? 0)))
  const flexibleTotal = flexibleAmounts.reduce((sum, size) => sum + size, 0)
  if (flexibleTotal <= 0) {
    return normalizeSizes(clamped, count)
  }

  return clamped.map((size, index) => {
    const reduction = overflow * (flexibleAmounts[index] / flexibleTotal)
    return Math.max(minimums[index] ?? 0, size - reduction)
  })
}

export const determineDropDirection = (rect: LayoutRect, clientX: number, clientY: number): DropDirection | null => {
  const x = clientX - rect.left
  const y = clientY - rect.top
  if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null

  const centerX1 = rect.width * 0.35
  const centerX2 = rect.width * 0.65
  const centerY1 = rect.height * 0.35
  const centerY2 = rect.height * 0.65
  if (x >= centerX1 && x <= centerX2 && y >= centerY1 && y <= centerY2) {
    return 'center'
  }

  const topWeight = y / rect.height
  const bottomWeight = 1 - topWeight
  const leftWeight = x / rect.width
  const rightWeight = 1 - leftWeight

  const min = Math.min(topWeight, bottomWeight, leftWeight, rightWeight)
  if (min === topWeight) return 'top'
  if (min === bottomWeight) return 'bottom'
  if (min === leftWeight) return 'left'
  return 'right'
}
