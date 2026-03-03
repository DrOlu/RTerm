export const LAYOUT_V2_SCHEMA_VERSION = 2

export const TECHNICAL_MIN_PANEL_SIZE_PX = 40
export const CHAT_MIN_GRID_ROWS = 2
export const CHAT_GRID_TOTAL_ROWS = 24
export const MAX_LAYOUT_PANELS = 32
export const MAX_LAYOUT_SPLIT_CHILDREN = 5

export type PanelKind = 'chat' | 'terminal' | 'filesystem' | 'fileEditor'

export type SplitDirection = 'horizontal' | 'vertical'

export type DropDirection = 'left' | 'right' | 'top' | 'bottom' | 'center'

export interface PanelInstance {
  id: string
  kind: PanelKind
}

export interface LayoutPanelNode {
  type: 'panel'
  id: string
  panel: PanelInstance
}

export interface LayoutSplitNode {
  type: 'split'
  id: string
  direction: SplitDirection
  children: LayoutNode[]
  /**
   * Percentage sizes for each child.
   * The array length must equal children length and values should sum to ~100.
   */
  sizes: number[]
}

export type LayoutNode = LayoutPanelNode | LayoutSplitNode

export interface LayoutTree {
  schemaVersion: number
  root: LayoutNode
  focusedPanelId?: string
  panelTabs?: Record<string, LayoutPanelTabBinding>
  managerPanels?: Partial<Record<PanelKind, string>>
}

export interface LayoutViewport {
  width: number
  height: number
}

export interface LayoutRect {
  left: number
  top: number
  width: number
  height: number
}

export interface NodeMinSize {
  minWidthPx: number
  minHeightPx: number
}

export interface PersistedLayoutV2 {
  schemaVersion: number
  root: LayoutNode
  focusedPanelId?: string
  panelTabs?: Record<string, LayoutPanelTabBinding>
  managerPanels?: Partial<Record<PanelKind, string>>
}

export interface LayoutPanelTabBinding {
  tabIds: string[]
  activeTabId?: string
}

export interface TabDragPayload {
  tabId: string
  kind: PanelKind
  sourcePanelId: string
}
