import { makeObservable, observable, action, computed, toJS, runInAction } from 'mobx'
import type { AppStore } from './AppStore'
import { PANEL_KIND_LIST, getPanelKindAdapter } from './panelKindAdapters'
import {
  MAX_LAYOUT_PANELS,
  buildLayoutTree,
  deriveLegacyLayoutSnapshot,
  getFirstPanelId,
  getPanelCount,
  listPanels,
  makeLayoutId,
  movePanel,
  removePanel,
  setSplitSizes,
  splitPanel,
  splitPanelWithPanelId,
  swapPanels,
  type DropDirection,
  type LayoutPanelTabBinding,
  type LayoutRect,
  type LayoutTree,
  type LayoutViewport,
  type PanelKind,
  type SplitDirection,
  type TabDragPayload
} from '../layout'
import { computeLayoutGeometry, validateLayoutTree } from '../layout'

const DEFAULT_VIEWPORT: LayoutViewport = {
  width: 0,
  height: 0
}

const PREVIEW_PANEL_ID = '__layout-preview-panel__'
const MIN_PANEL_COUNT_BY_KIND: Partial<Record<PanelKind, number>> = {}

const getMinPanelCountForKind = (kind: PanelKind): number => MIN_PANEL_COUNT_BY_KIND[kind] ?? 0

const toSplitPlacement = (
  direction: DropDirection
): { direction: SplitDirection; position: 'before' | 'after' } | null => {
  if (direction === 'left') return { direction: 'horizontal', position: 'before' }
  if (direction === 'right') return { direction: 'horizontal', position: 'after' }
  if (direction === 'top') return { direction: 'vertical', position: 'before' }
  if (direction === 'bottom') return { direction: 'vertical', position: 'after' }
  return null
}

const unique = (items: string[]): string[] => {
  const seen = new Set<string>()
  const next: string[] = []
  items.forEach((item) => {
    if (!item || seen.has(item)) return
    seen.add(item)
    next.push(item)
  })
  return next
}

type DragType = 'panel' | 'tab' | null
type TabReorderTarget = {
  panelId: string
  anchorTabId: string | null
  position: 'before' | 'after'
} | null

export class LayoutStore {
  tree: LayoutTree = buildLayoutTree(undefined)
  isReady = false

  viewport: LayoutViewport = { ...DEFAULT_VIEWPORT }

  // Drag state
  isDragging = false
  dragType: DragType = null
  draggingPanelId: string | null = null
  draggingTab: TabDragPayload | null = null
  dragX = 0
  dragY = 0
  dropTargetPanelId: string | null = null
  dropDirection: DropDirection | null = null
  dropPreviewRect: LayoutRect | null = null
  tabReorderTarget: TabReorderTarget = null

  private appStore: AppStore
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  private pinnedEmptyPanelIds = new Set<string>()

  constructor(appStore: AppStore) {
    this.appStore = appStore
    makeObservable(this, {
      tree: observable,
      isReady: observable,
      viewport: observable,
      isDragging: observable,
      dragType: observable,
      draggingPanelId: observable,
      draggingTab: observable,
      dragX: observable,
      dragY: observable,
      dropTargetPanelId: observable,
      dropDirection: observable,
      dropPreviewRect: observable,
      tabReorderTarget: observable,
      panelOrder: computed,
      panelSizes: computed,
      panelNodes: computed,
      panelCount: computed,
      geometry: computed,
      bootstrap: action,
      pinPanelsAsRestorePlaceholder: action,
      syncPanelBindings: action,
      setViewport: action,
      setSplitSizes: action,
      splitPanel: action,
      removePanel: action,
      ensurePrimaryPanelForKind: action,
      focusPrimaryPanel: action,
      attachTabToPanel: action,
      attachTabToPrimaryPanel: action,
      splitTabToDirection: action,
      detachTabsFromLayout: action,
      detachTabFromLayout: action,
      importPanelFromExternal: action,
      setTabReorderTarget: action,
      clearTabReorderTarget: action,
      setFocusedPanel: action,
      setPanelActiveTab: action,
      startPanelDragging: action,
      startTabDragging: action,
      setDragPointer: action,
      setDropTarget: action,
      clearDragging: action,
      commitDragging: action,
      swapPanels: action
    })
  }

  get panelNodes() {
    return listPanels(this.tree)
  }

  get panelCount(): number {
    return this.panelNodes.length
  }

  get geometry() {
    return computeLayoutGeometry(this.tree, this.viewport)
  }

  /**
   * Compatibility projection for legacy code paths.
   */
  get panelOrder(): PanelKind[] {
    return this.panelNodes.map((node) => node.panel.kind)
  }

  /**
   * Compatibility projection for legacy code paths.
   */
  get panelSizes(): number[] {
    return deriveLegacyLayoutSnapshot(this.tree).panelSizes
  }

  get panelTabs(): Record<string, LayoutPanelTabBinding> {
    return this.tree.panelTabs || {}
  }

  bootstrap() {
    const settings = this.appStore.settings
    const tree = buildLayoutTree(settings?.layout)
    this.tree = tree

    if (!this.tree.focusedPanelId) {
      this.tree.focusedPanelId = getFirstPanelId(this.tree) ?? undefined
    }
    this.syncPanelBindings({ persist: false })
    this.isReady = true
  }

  getPanelsWithMissingTabBindings(kind: PanelKind, ownerTabIds: Iterable<string>): string[] {
    if (!getPanelKindAdapter(kind).supportsTabs) {
      return []
    }
    const ownerSet = new Set<string>(ownerTabIds)
    const panels = this.panelNodes.filter((node) => node.panel.kind === kind)
    const missingPanels: string[] = []

    panels.forEach((panel) => {
      const panelId = panel.panel.id
      const persistedTabIds = this.tree.panelTabs?.[panelId]?.tabIds || []
      if (!persistedTabIds.length) return
      const hasMissingTabId = persistedTabIds.some((tabId) => !ownerSet.has(tabId))
      if (!hasMissingTabId) return
      missingPanels.push(panelId)
    })

    return missingPanels
  }

  pinPanelsAsRestorePlaceholder(panelIds: string[]): void {
    if (!Array.isArray(panelIds) || panelIds.length === 0) return
    const panelIdSet = new Set(this.panelNodes.map((node) => node.panel.id))
    panelIds.forEach((panelId) => {
      if (!panelIdSet.has(panelId)) return
      this.pinnedEmptyPanelIds.add(panelId)
    })
  }

  syncPanelBindings(options?: { persist?: boolean }) {
    const persist = options?.persist !== false
    const currentPanelIds = new Set(this.panelNodes.map((node) => node.panel.id))
    Array.from(this.pinnedEmptyPanelIds).forEach((panelId) => {
      if (!currentPanelIds.has(panelId)) {
        this.pinnedEmptyPanelIds.delete(panelId)
      }
    })

    let nextTree = this.tree
    let pass = 0
    while (pass < MAX_LAYOUT_PANELS + 2) {
      pass += 1
      nextTree = this.enforcePanelKindLimits(nextTree)
      const panelTabs = this.computeBindingsForTree(nextTree)
      const { managerPanels: _legacyManagerPanels, ...treeWithoutManager } = nextTree as LayoutTree & {
        managerPanels?: Partial<Record<PanelKind, string>>
      }
      nextTree = {
        ...treeWithoutManager,
        panelTabs
      }
      Object.entries(panelTabs).forEach(([panelId, binding]) => {
        if ((binding.tabIds || []).length > 0) {
          this.pinnedEmptyPanelIds.delete(panelId)
        }
      })
      const removableEmptyPanelId = this.findAutoRemovableEmptyPanelId(nextTree, panelTabs)
      if (!removableEmptyPanelId) {
        break
      }
      const pruned = removePanel(nextTree, removableEmptyPanelId)
      if (pruned === nextTree) {
        break
      }
      nextTree = pruned
    }

    this.tree = nextTree
    const nextPanelIds = new Set(listPanels(nextTree).map((panel) => panel.panel.id))
    Array.from(this.pinnedEmptyPanelIds).forEach((panelId) => {
      if (!nextPanelIds.has(panelId)) {
        this.pinnedEmptyPanelIds.delete(panelId)
      }
    })
    if (this.isDragging) {
      this.dropPreviewRect = this.computeDropPreviewRect()
    }

    if (persist) {
      this.saveLayoutDebounced()
    }
  }

  setViewport(width: number, height: number) {
    this.viewport = {
      width: Number.isFinite(width) ? Math.max(0, width) : 0,
      height: Number.isFinite(height) ? Math.max(0, height) : 0
    }
    if (this.isDragging) {
      this.dropPreviewRect = this.computeDropPreviewRect()
    }
  }

  setSplitSizes(splitNodeId: string, sizes: number[]) {
    const nextTree = setSplitSizes(this.tree, splitNodeId, sizes)
    this.applyTree(nextTree)
  }

  splitPanel(targetPanelId: string, kind: PanelKind, direction: 'horizontal' | 'vertical', position: 'before' | 'after') {
    const nextTree = splitPanel(this.tree, targetPanelId, kind, direction, position)
    if (nextTree !== this.tree && nextTree.focusedPanelId) {
      this.pinnedEmptyPanelIds.add(nextTree.focusedPanelId)
    }
    this.applyTree(nextTree)
  }

  removePanel(panelId: string) {
    if (!this.canRemovePanel(panelId)) return
    this.pinnedEmptyPanelIds.delete(panelId)
    const nextTree = removePanel(this.tree, panelId)
    this.applyTree(nextTree)
  }

  swapPanels(panelAId: string, panelBId: string) {
    const nextTree = swapPanels(this.tree, panelAId, panelBId)
    this.applyTree(nextTree)
  }

  canRemovePanel(panelId: string): boolean {
    if (this.panelCount <= 1) return false
    const panelNode = this.panelNodes.find((node) => node.panel.id === panelId)
    if (!panelNode) return false

    const minCount = getMinPanelCountForKind(panelNode.panel.kind)
    if (minCount <= 0) return true

    const sameKindPanelCount = this.panelNodes.filter((node) => node.panel.kind === panelNode.panel.kind).length
    return sameKindPanelCount > minCount
  }

  setFocusedPanel(panelId: string) {
    this.tree = {
      ...this.tree,
      focusedPanelId: panelId
    }
    this.saveLayoutDebounced()
  }

  getPanelIdsByKind(kind: PanelKind): string[] {
    return this.panelNodes.filter((node) => node.panel.kind === kind).map((node) => node.panel.id)
  }

  getPrimaryPanelId(kind: PanelKind): string | null {
    return this.getPanelIdsByKind(kind)[0] || null
  }

  getPanelTabIds(panelId: string): string[] {
    return this.tree.panelTabs?.[panelId]?.tabIds || []
  }

  getPanelActiveTabId(panelId: string): string | null {
    const binding = this.tree.panelTabs?.[panelId]
    if (!binding) return null
    if (binding.activeTabId && binding.tabIds.includes(binding.activeTabId)) {
      return binding.activeTabId
    }
    return binding.tabIds[0] || null
  }

  setPanelActiveTab(panelId: string, tabId: string) {
    const kind = this.getPanelKindById(panelId)
    if (!kind) return
    const adapter = getPanelKindAdapter(kind)
    if (!adapter.supportsTabs) return
    const current = this.tree.panelTabs?.[panelId]
    if (!current || !current.tabIds.includes(tabId)) return

    this.tree = {
      ...this.tree,
      panelTabs: {
        ...this.tree.panelTabs,
        [panelId]: {
          ...current,
          activeTabId: tabId
        }
      },
      focusedPanelId: panelId
    }
    this.saveLayoutDebounced()
    this.syncGlobalActiveFromPanel(kind, tabId)
  }

  ensurePrimaryPanelForKind(kind: PanelKind): string | null {
    const existing = this.getPrimaryPanelId(kind)
    if (existing) {
      return existing
    }
    if (this.panelCount >= MAX_LAYOUT_PANELS) {
      return null
    }

    const targetPanelId =
      (this.tree.focusedPanelId && this.panelNodes.some((node) => node.panel.id === this.tree.focusedPanelId)
        ? this.tree.focusedPanelId
        : this.panelNodes[0]?.panel.id) || null
    if (!targetPanelId) {
      return null
    }

    const createdPanelId = makeLayoutId(`panel-${kind}`)
    const nextTree = splitPanelWithPanelId(
      this.tree,
      targetPanelId,
      {
        kind,
        panelId: createdPanelId
      },
      'horizontal',
      'after'
    )
    if (nextTree === this.tree) {
      return null
    }
    this.pinnedEmptyPanelIds.add(createdPanelId)
    this.applyTree(nextTree)
    return this.getPrimaryPanelId(kind)
  }

  focusPrimaryPanel(kind: PanelKind): string | null {
    const panelId = this.getPrimaryPanelId(kind)
    if (!panelId) return null
    this.setFocusedPanel(panelId)
    return panelId
  }

  attachTabToPanel(kind: PanelKind, tabId: string, targetPanelId: string) {
    this.moveTabBinding(kind, tabId, targetPanelId)
  }

  attachTabToPrimaryPanel(kind: PanelKind, tabId: string) {
    const panelId = this.getPrimaryPanelId(kind)
    if (!panelId) return
    this.moveTabBinding(kind, tabId, panelId)
  }

  splitTabToDirection(
    payload: TabDragPayload,
    targetPanelId: string,
    direction: Exclude<DropDirection, 'center'>
  ) {
    if (!getPanelKindAdapter(payload.kind).supportsTabs) {
      return
    }
    this.commitTabDrop(payload, targetPanelId, direction)
  }

  detachTabsFromLayout(kind: PanelKind, tabIds: string[]): void {
    if (!getPanelKindAdapter(kind).supportsTabs) {
      return
    }
    if (!Array.isArray(tabIds) || tabIds.length === 0) return
    const detachSet = new Set(
      tabIds
        .map((tabId) => String(tabId || '').trim())
        .filter((tabId) => tabId.length > 0)
    )
    if (detachSet.size === 0) return

    const panelIds = this.panelNodes
      .filter((node) => node.panel.kind === kind)
      .map((node) => node.panel.id)
    if (panelIds.length === 0) return

    const nextPanelTabs: Record<string, LayoutPanelTabBinding> = {
      ...(this.tree.panelTabs || {})
    }
    let changed = false

    panelIds.forEach((panelId) => {
      const current = nextPanelTabs[panelId]
      if (!current) {
        return
      }
      const tabIds = current.tabIds.filter((id) => !detachSet.has(id))
      if (tabIds.length === current.tabIds.length) {
        return
      }
      const activeTabId =
        current.activeTabId && tabIds.includes(current.activeTabId)
          ? current.activeTabId
          : tabIds[0]
      nextPanelTabs[panelId] = {
        tabIds,
        ...(activeTabId ? { activeTabId } : {})
      }
      changed = true
    })

    if (!changed) {
      return
    }

    this.tree = {
      ...this.tree,
      panelTabs: nextPanelTabs
    }
    this.syncPanelBindings({ persist: false })
    this.saveLayoutDebounced()
  }

  detachTabFromLayout(kind: PanelKind, tabId: string): void {
    this.detachTabsFromLayout(kind, [tabId])
  }

  importPanelFromExternal(
    kind: PanelKind,
    tabBinding?: LayoutPanelTabBinding,
    dropTarget?: { panelId: string; direction: DropDirection }
  ): string | null {
    if (this.panelCount >= MAX_LAYOUT_PANELS) {
      return null
    }

    let targetPanelId: string
    let splitDirection: SplitDirection = 'horizontal'
    let splitPosition: 'before' | 'after' = 'after'

    if (dropTarget && dropTarget.direction !== 'center') {
      const placement = toSplitPlacement(dropTarget.direction)
      if (placement && this.panelNodes.some((node) => node.panel.id === dropTarget.panelId)) {
        targetPanelId = dropTarget.panelId
        splitDirection = placement.direction
        splitPosition = placement.position
      } else {
        const fallback =
          (this.tree.focusedPanelId && this.panelNodes.some((node) => node.panel.id === this.tree.focusedPanelId)
            ? this.tree.focusedPanelId
            : this.panelNodes[0]?.panel.id) || null
        if (!fallback) return null
        targetPanelId = fallback
      }
    } else {
      const anchorPanelId =
        (this.tree.focusedPanelId && this.panelNodes.some((node) => node.panel.id === this.tree.focusedPanelId)
          ? this.tree.focusedPanelId
          : this.panelNodes[0]?.panel.id) || null
      if (!anchorPanelId) return null
      targetPanelId = anchorPanelId
    }

    const normalizedTabBinding = (() => {
      if (!getPanelKindAdapter(kind).supportsTabs || !tabBinding) {
        return undefined
      }
      const tabIds = unique(
        (tabBinding.tabIds || []).filter((tabId): tabId is string => typeof tabId === 'string' && tabId.length > 0)
      )
      const activeTabId =
        typeof tabBinding.activeTabId === 'string' && tabIds.includes(tabBinding.activeTabId)
          ? tabBinding.activeTabId
          : tabIds[0]
      return {
        tabIds,
        ...(activeTabId ? { activeTabId } : {})
      }
    })()

    const baseTree =
      normalizedTabBinding && normalizedTabBinding.tabIds.length > 0
        ? this.createTreeWithoutTabs(this.tree, kind, normalizedTabBinding.tabIds)
        : this.tree

    const panelId = makeLayoutId(`panel-${kind}`)
    const splitTree = splitPanelWithPanelId(
      baseTree,
      targetPanelId,
      {
        kind,
        panelId
      },
      splitDirection,
      splitPosition
    )
    if (splitTree === this.tree) {
      return null
    }

    let nextTree = splitTree
    if (normalizedTabBinding) {
      nextTree = {
        ...splitTree,
        panelTabs: {
          ...(splitTree.panelTabs || {}),
          [panelId]: {
            tabIds: normalizedTabBinding.tabIds,
            ...(normalizedTabBinding.activeTabId ? { activeTabId: normalizedTabBinding.activeTabId } : {})
          }
        },
        focusedPanelId: panelId
      }
    }

    const treeBefore = this.tree
    this.applyTree(nextTree)
    if (this.tree === treeBefore) {
      return null
    }
    if (getPanelKindAdapter(kind).supportsTabs) {
      const importedActiveTabId = nextTree.panelTabs?.[panelId]?.activeTabId
      if (importedActiveTabId) {
        this.syncGlobalActiveFromPanel(kind, importedActiveTabId)
      }
    }
    return panelId
  }

  setTabReorderTarget(panelId: string, anchorTabId: string | null, position: 'before' | 'after') {
    this.tabReorderTarget = {
      panelId,
      anchorTabId,
      position
    }
    this.dropPreviewRect = this.computeDropPreviewRect()
  }

  clearTabReorderTarget() {
    this.tabReorderTarget = null
    this.dropPreviewRect = this.computeDropPreviewRect()
  }

  startPanelDragging(panelId: string, x: number, y: number) {
    this.isDragging = true
    this.dragType = 'panel'
    this.draggingPanelId = panelId
    this.draggingTab = null
    this.dragX = x
    this.dragY = y
    this.dropTargetPanelId = null
    this.dropDirection = null
    this.dropPreviewRect = null
    this.tabReorderTarget = null
  }

  startTabDragging(payload: TabDragPayload, x: number, y: number) {
    this.isDragging = true
    this.dragType = 'tab'
    this.draggingPanelId = null
    this.draggingTab = payload
    this.dragX = x
    this.dragY = y
    this.dropTargetPanelId = null
    this.dropDirection = null
    this.dropPreviewRect = null
    this.tabReorderTarget = null
  }

  setDragPointer(x: number, y: number) {
    this.dragX = x
    this.dragY = y
  }

  setDropTarget(panelId: string | null, direction: DropDirection | null) {
    this.dropTargetPanelId = panelId
    this.dropDirection = direction
    if (direction !== 'center') {
      this.tabReorderTarget = null
    }
    this.dropPreviewRect = this.computeDropPreviewRect()
  }

  clearDragging() {
    this.isDragging = false
    this.dragType = null
    this.draggingPanelId = null
    this.draggingTab = null
    this.dropTargetPanelId = null
    this.dropDirection = null
    this.dropPreviewRect = null
    this.tabReorderTarget = null
  }

  commitDragging() {
    if (!this.isDragging || !this.dropTargetPanelId || !this.dropDirection) {
      this.clearDragging()
      return
    }

    if (this.dragType === 'panel' && this.draggingPanelId) {
      const nextTree = movePanel(this.tree, this.draggingPanelId, this.dropTargetPanelId, this.dropDirection)
      this.clearDragging()
      this.applyTree(nextTree)
      return
    }

    if (this.dragType === 'tab' && this.draggingTab) {
      const payload = this.draggingTab
      const targetPanelId = this.dropTargetPanelId
      const dropDirection = this.dropDirection
      const reorderTarget = this.tabReorderTarget
      this.clearDragging()
      this.commitTabDrop(payload, targetPanelId, dropDirection, reorderTarget || undefined)
      return
    }

    this.clearDragging()
  }

  getPanelRect(panelId: string): LayoutRect | null {
    return this.geometry.panelRects[panelId] || null
  }

  private commitTabDrop(
    payload: TabDragPayload,
    targetPanelId: string,
    direction: DropDirection,
    reorderTarget?: Exclude<TabReorderTarget, null>
  ) {
    if (!getPanelKindAdapter(payload.kind).supportsTabs) {
      return
    }
    if (!this.canAcceptTabDrop(payload, targetPanelId, direction)) {
      return
    }

    if (direction === 'center') {
      this.moveTabBinding(
        payload.kind,
        payload.tabId,
        targetPanelId,
        reorderTarget
          ? {
              anchorTabId: reorderTarget.anchorTabId,
              position: reorderTarget.position
            }
          : undefined
      )
      this.setPanelActiveTab(targetPanelId, payload.tabId)
      return
    }

    const splitPlacement = toSplitPlacement(direction)
    if (!splitPlacement) {
      return
    }

    const newPanelId = makeLayoutId(`panel-${payload.kind}`)
    const nextTree = splitPanelWithPanelId(
      this.tree,
      targetPanelId,
      {
        kind: payload.kind,
        panelId: newPanelId
      },
      splitPlacement.direction,
      splitPlacement.position
    )
    const nextWithBinding = this.createTreeWithMovedTab(nextTree, payload.kind, payload.tabId, newPanelId)
    if (!nextWithBinding) {
      return
    }
    this.applyTree(nextWithBinding)
    this.syncGlobalActiveFromPanel(payload.kind, payload.tabId)
  }

  private computeDropPreviewRect(): LayoutRect | null {
    if (!this.isDragging || !this.dropTargetPanelId || !this.dropDirection) {
      return null
    }

    if (this.dragType === 'panel' && this.draggingPanelId) {
      const projectedTree = movePanel(this.tree, this.draggingPanelId, this.dropTargetPanelId, this.dropDirection)
      if (projectedTree === this.tree) return null
      if (!validateLayoutTree(projectedTree, this.viewport).valid) return null
      const projectedGeometry = computeLayoutGeometry(projectedTree, this.viewport)
      return projectedGeometry.panelRects[this.draggingPanelId] || null
    }

    if (this.dragType === 'tab' && this.draggingTab) {
      if (!this.canAcceptTabDrop(this.draggingTab, this.dropTargetPanelId, this.dropDirection)) {
        return null
      }
      if (this.dropDirection === 'center') {
        if (
          this.tabReorderTarget &&
          this.tabReorderTarget.panelId === this.dropTargetPanelId
        ) {
          return null
        }
        return this.geometry.panelRects[this.dropTargetPanelId] || null
      }
      const splitPlacement = toSplitPlacement(this.dropDirection)
      if (!splitPlacement) return null
      const projectedTree = splitPanelWithPanelId(
        this.tree,
        this.dropTargetPanelId,
        {
          kind: this.draggingTab.kind,
          panelId: PREVIEW_PANEL_ID
        },
        splitPlacement.direction,
        splitPlacement.position
      )
      if (!validateLayoutTree(projectedTree, this.viewport).valid) return null
      const projectedGeometry = computeLayoutGeometry(projectedTree, this.viewport)
      return projectedGeometry.panelRects[PREVIEW_PANEL_ID] || null
    }

    return null
  }

  private canAcceptTabDrop(payload: TabDragPayload, targetPanelId: string, direction: DropDirection): boolean {
    if (!getPanelKindAdapter(payload.kind).supportsTabs) {
      return false
    }
    const targetKind = this.getPanelKindById(targetPanelId)
    if (!targetKind || targetKind !== payload.kind) return false

    if (direction === 'center') {
      return true
    }

    if (this.panelCount >= MAX_LAYOUT_PANELS) {
      return false
    }

    const splitPlacement = toSplitPlacement(direction)
    if (!splitPlacement) {
      return false
    }

    const projectedTree = splitPanelWithPanelId(
      this.tree,
      targetPanelId,
      {
        kind: payload.kind,
        panelId: PREVIEW_PANEL_ID
      },
      splitPlacement.direction,
      splitPlacement.position
    )
    return validateLayoutTree(projectedTree, this.viewport).valid
  }

  getPanelKindById(panelId: string): PanelKind | null {
    return this.panelNodes.find((node) => node.panel.id === panelId)?.panel.kind || null
  }

  private computeBindingsForTree(tree: LayoutTree): Record<string, LayoutPanelTabBinding> {
    const panelNodes = listPanels(tree)
    const panelTabs: Record<string, LayoutPanelTabBinding> = {}

    PANEL_KIND_LIST.forEach((kind) => {
      const adapter = getPanelKindAdapter(kind)
      const inventoryHydrated = adapter.isOwnerInventoryHydrated(this.appStore)
      const panelIds = panelNodes.filter((node) => node.panel.kind === kind).map((node) => node.panel.id)
      if (panelIds.length === 0) {
        return
      }

      if (!adapter.supportsTabs) {
        return
      }

      if (!inventoryHydrated) {
        panelIds.forEach((panelId) => {
          const existing = tree.panelTabs?.[panelId]
          const tabIds = unique(existing?.tabIds || [])
          const activeTabId = existing?.activeTabId && tabIds.includes(existing.activeTabId) ? existing.activeTabId : tabIds[0]
          panelTabs[panelId] = {
            tabIds,
            ...(activeTabId ? { activeTabId } : {})
          }
        })
        return
      }

      const ownerTabIds = adapter.getOwnerTabIds(this.appStore)
      const ownerSet = new Set(ownerTabIds)
      const consumed = new Set<string>()

      panelIds.forEach((panelId) => {
        const existing = tree.panelTabs?.[panelId]
        const tabIds = unique((existing?.tabIds || []).filter((id) => ownerSet.has(id) && !consumed.has(id)))
        tabIds.forEach((id) => consumed.add(id))
        panelTabs[panelId] = {
          tabIds,
          ...(existing?.activeTabId ? { activeTabId: existing.activeTabId } : {})
        }
      })

      const missing = ownerTabIds.filter((tabId) => !consumed.has(tabId))
      if (missing.length > 0) {
        const primaryPanelId = panelIds[0]
        panelTabs[primaryPanelId] = {
          ...panelTabs[primaryPanelId],
          tabIds: unique([...(panelTabs[primaryPanelId]?.tabIds || []), ...missing])
        }
      }

      panelIds.forEach((panelId) => {
        const binding = panelTabs[panelId]
        if (!binding) return
        const activeTabId = binding.activeTabId
        if (!activeTabId || !binding.tabIds.includes(activeTabId)) {
          panelTabs[panelId] = {
            ...binding,
            ...(binding.tabIds[0] ? { activeTabId: binding.tabIds[0] } : {})
          }
          if (binding.tabIds.length === 0) {
            delete panelTabs[panelId].activeTabId
          }
        }
      })

      const globalActiveTabId = adapter.getGlobalActiveTabId(this.appStore)
      if (globalActiveTabId) {
        const activeOwnerPanelId = panelIds.find((panelId) => panelTabs[panelId]?.tabIds.includes(globalActiveTabId))
        if (activeOwnerPanelId) {
          panelTabs[activeOwnerPanelId] = {
            ...panelTabs[activeOwnerPanelId],
            activeTabId: globalActiveTabId
          }
        }
      }
    })

    return panelTabs
  }

  private findAutoRemovableEmptyPanelId(
    tree: LayoutTree,
    panelTabs: Record<string, LayoutPanelTabBinding>
  ): string | null {
    const panels = listPanels(tree)
    const panelCountByKind = new Map<PanelKind, number>()
    panels.forEach((panel) => {
      const kind = panel.panel.kind
      panelCountByKind.set(kind, (panelCountByKind.get(kind) || 0) + 1)
    })
    const eligible = panels.filter((panel) => {
      const adapter = getPanelKindAdapter(panel.panel.kind)
      if (!adapter.supportsTabs) {
        return false
      }
      if (!adapter.isOwnerInventoryHydrated(this.appStore)) {
        return false
      }
      const kindCount = panelCountByKind.get(panel.panel.kind) || 0
      if (kindCount <= getMinPanelCountForKind(panel.panel.kind)) {
        return false
      }
      if (this.pinnedEmptyPanelIds.has(panel.panel.id)) {
        return false
      }
      const tabIds = panelTabs[panel.panel.id]?.tabIds || []
      if (tabIds.length > 0) return false
      return panels.length > 1
    })
    if (eligible.length === 0) return null

    return eligible[0]?.panel.id || null
  }

  private moveTabBinding(
    kind: PanelKind,
    tabId: string,
    targetPanelId: string,
    options?: {
      anchorTabId?: string | null
      position?: 'before' | 'after'
    }
  ) {
    if (!getPanelKindAdapter(kind).supportsTabs) {
      return
    }
    const nextTree = this.createTreeWithMovedTab(this.tree, kind, tabId, targetPanelId, options)
    if (!nextTree) return
    this.tree = nextTree
    this.syncPanelBindings({ persist: false })
    this.saveLayoutDebounced()
    this.syncGlobalActiveFromPanel(kind, tabId)
  }

  private createTreeWithoutTabs(
    tree: LayoutTree,
    kind: PanelKind,
    tabIdsToRemove: string[]
  ): LayoutTree {
    if (!getPanelKindAdapter(kind).supportsTabs) {
      return tree
    }
    const removalSet = new Set(
      tabIdsToRemove
        .map((tabId) => String(tabId || '').trim())
        .filter((tabId) => tabId.length > 0)
    )
    if (removalSet.size === 0) {
      return tree
    }

    const panelIds = listPanels(tree)
      .filter((node) => node.panel.kind === kind)
      .map((node) => node.panel.id)
    if (panelIds.length === 0) {
      return tree
    }

    const nextPanelTabs: Record<string, LayoutPanelTabBinding> = {
      ...(tree.panelTabs || {})
    }
    let changed = false

    panelIds.forEach((panelId) => {
      const current = nextPanelTabs[panelId]
      if (!current) {
        return
      }
      const nextTabIds = current.tabIds.filter((tabId) => !removalSet.has(tabId))
      if (nextTabIds.length === current.tabIds.length) {
        return
      }
      const activeTabId =
        current.activeTabId && nextTabIds.includes(current.activeTabId)
          ? current.activeTabId
          : nextTabIds[0]
      nextPanelTabs[panelId] = {
        tabIds: nextTabIds,
        ...(activeTabId ? { activeTabId } : {})
      }
      changed = true
    })

    if (!changed) {
      return tree
    }

    return {
      ...tree,
      panelTabs: nextPanelTabs
    }
  }

  private createTreeWithMovedTab(
    tree: LayoutTree,
    kind: PanelKind,
    tabId: string,
    targetPanelId: string,
    options?: {
      anchorTabId?: string | null
      position?: 'before' | 'after'
    }
  ): LayoutTree | null {
    if (!getPanelKindAdapter(kind).supportsTabs) {
      return null
    }
    const panelIds = listPanels(tree)
      .filter((node) => node.panel.kind === kind)
      .map((node) => node.panel.id)
    if (!panelIds.includes(targetPanelId)) return null

    const nextPanelTabs: Record<string, LayoutPanelTabBinding> = {
      ...(tree.panelTabs || {})
    }

    panelIds.forEach((panelId) => {
      const current = nextPanelTabs[panelId] || { tabIds: [] }
      const tabIds = current.tabIds.filter((id) => id !== tabId)
      const nextBinding: LayoutPanelTabBinding = {
        tabIds,
        ...(current.activeTabId ? { activeTabId: current.activeTabId } : {})
      }
      if (!nextBinding.activeTabId || !tabIds.includes(nextBinding.activeTabId)) {
        if (tabIds[0]) {
          nextBinding.activeTabId = tabIds[0]
        } else {
          delete nextBinding.activeTabId
        }
      }
      nextPanelTabs[panelId] = nextBinding
    })

    const target = nextPanelTabs[targetPanelId] || { tabIds: [] }
    const targetTabIds = unique(target.tabIds)
    const anchorTabId = options?.anchorTabId || null
    const targetAnchorIndex = anchorTabId ? targetTabIds.indexOf(anchorTabId) : -1
    const insertionIndex = (() => {
      if (targetAnchorIndex < 0) return targetTabIds.length
      if (options?.position === 'before') return targetAnchorIndex
      return targetAnchorIndex + 1
    })()
    targetTabIds.splice(Math.max(0, Math.min(targetTabIds.length, insertionIndex)), 0, tabId)
    nextPanelTabs[targetPanelId] = {
      ...target,
      tabIds: targetTabIds,
      activeTabId: tabId
    }

    return {
      ...tree,
      panelTabs: nextPanelTabs,
      focusedPanelId: targetPanelId
    }
  }

  private syncGlobalActiveFromPanel(kind: PanelKind, tabId: string) {
    const adapter = getPanelKindAdapter(kind)
    if (!adapter.supportsTabs) {
      return
    }
    adapter.setGlobalActiveTab(this.appStore, tabId)
  }

  private enforcePanelKindLimits(tree: LayoutTree): LayoutTree {
    let nextTree = tree
    PANEL_KIND_LIST.forEach((kind) => {
      const adapter = getPanelKindAdapter(kind)
      const maxPanels = adapter.maxPanels
      if (!Number.isFinite(maxPanels) || !maxPanels || maxPanels <= 0) {
        return
      }
      let panelIds = listPanels(nextTree)
        .filter((node) => node.panel.kind === kind)
        .map((node) => node.panel.id)
      while (panelIds.length > maxPanels) {
        const panelIdToRemove = panelIds[panelIds.length - 1]
        if (!panelIdToRemove) break
        const pruned = removePanel(nextTree, panelIdToRemove)
        if (pruned === nextTree) {
          break
        }
        this.pinnedEmptyPanelIds.delete(panelIdToRemove)
        nextTree = pruned
        this.appStore.onPanelRemoved(kind)
        panelIds = listPanels(nextTree)
          .filter((node) => node.panel.kind === kind)
          .map((node) => node.panel.id)
      }
    })
    return nextTree
  }

  private applyTree(nextTree: LayoutTree) {
    if (nextTree === this.tree) return

    if (getPanelCount(nextTree) <= 0) {
      return
    }

    const validation = validateLayoutTree(nextTree, this.viewport)
    if (!validation.valid) {
      return
    }

    const focused = nextTree.focusedPanelId
    if (!focused || !nextTree.root) {
      nextTree.focusedPanelId = getFirstPanelId(nextTree) ?? undefined
    }

    this.tree = nextTree
    this.syncPanelBindings({ persist: false })
    this.saveLayoutDebounced()
  }

  private saveLayoutDebounced() {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }

    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      void this.saveLayout()
    }, 120)
  }

  private async saveLayout() {
    if (typeof (this.appStore as any).shouldPersistLayout === 'function') {
      const canPersist = (this.appStore as any).shouldPersistLayout()
      if (!canPersist) {
        return
      }
    }

    const legacy = deriveLegacyLayoutSnapshot(this.tree)
    const treeSnapshot = toJS(this.tree)

    await window.gyshell.settings.set({
      layout: {
        panelOrder: legacy.panelOrder,
        panelSizes: legacy.panelSizes,
        v2: treeSnapshot
      }
    })

    runInAction(() => {
      if (this.appStore.settings) {
        this.appStore.settings = {
          ...this.appStore.settings,
          layout: {
            ...this.appStore.settings.layout,
            panelOrder: legacy.panelOrder,
            panelSizes: legacy.panelSizes,
            v2: treeSnapshot
          }
        }
      }
    })
  }
}
