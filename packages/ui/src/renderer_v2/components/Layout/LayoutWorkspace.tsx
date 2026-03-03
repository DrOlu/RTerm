import React from 'react'
import { observer } from 'mobx-react-lite'
import clsx from 'clsx'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import type { ImperativePanelGroupHandle } from 'react-resizable-panels'
import { Trash2 } from 'lucide-react'
import type { AppStore } from '../../stores/AppStore'
import {
  MAX_LAYOUT_PANELS,
  computeChildMinSizePercentages,
  determineDropDirection,
  type LayoutNode,
  type LayoutRect,
  type LayoutSplitNode,
  type PanelKind,
  type TabDragPayload
} from '../../layout'
import { ConfirmDialog } from '../Common/ConfirmDialog'
import { renderPanelByKind } from './panelRenderRegistry'
import { PanelTypeRail } from './PanelTypeRail'
import { getPanelKindAdapter } from '../../stores/panelKindAdapters'

interface LayoutWorkspaceProps {
  store: AppStore
}

type LayoutMenuMode = 'tab' | 'bar'

type LayoutMenuAction =
  | 'close-tab'
  | 'close-other-tabs'
  | 'close-all-tabs'
  | 'split-left'
  | 'split-right'
  | 'split-up'
  | 'split-down'
  | 'close-panel'

type LayoutMenuLabelKey =
  | 'closeTab'
  | 'closeOtherTabs'
  | 'closeAllTabs'
  | 'splitLeft'
  | 'splitRight'
  | 'splitUp'
  | 'splitDown'
  | 'closePanel'

interface LayoutMenuState {
  panelId: string
  panelKind: PanelKind
  mode: LayoutMenuMode
  targetTabId: string | null
  x: number
  y: number
}

interface PendingTerminalCloseRequest {
  tabIds: string[]
}

const DragOverlay: React.FC<{
  targetRect: LayoutRect | null
  previewRect: LayoutRect | null
}> = ({ targetRect, previewRect }) => {
  if (!targetRect && !previewRect) return null
  return (
    <>
      {targetRect ? (
        <div
          className="gyshell-layout-drop-target-overlay"
          style={{
            left: targetRect.left,
            top: targetRect.top,
            width: targetRect.width,
            height: targetRect.height
          }}
        />
      ) : null}
      {previewRect ? (
        <div
          className="gyshell-layout-drop-preview-overlay"
          style={{
            left: previewRect.left,
            top: previewRect.top,
            width: previewRect.width,
            height: previewRect.height
          }}
        />
      ) : null}
    </>
  )
}

const PanelLeaf: React.FC<{
  node: Extract<LayoutNode, { type: 'panel' }>
  store: AppStore
  onHeaderMouseDown: (panelId: string, event: React.MouseEvent<HTMLElement>) => void
  onHeaderContextMenu: (panelId: string, event: React.MouseEvent<HTMLElement>) => void
  onRequestCloseTabsByKind: (kind: PanelKind, tabIds: string[]) => void
}> = observer(({ node, store, onHeaderMouseDown, onHeaderContextMenu, onRequestCloseTabsByKind }) => {
  const panelId = node.panel.id
  const dragSource = store.layout.isDragging && store.layout.draggingPanelId === panelId
  const isDropTarget = store.layout.isDragging && store.layout.dropTargetPanelId === panelId
  const panelTabIds = store.layout.getPanelTabIds(panelId)

  return (
    <div
      className={clsx('gyshell-layout-leaf', {
        'is-drag-source': dragSource,
        'is-drop-target': isDropTarget
      })}
      data-layout-panel-id={panelId}
      data-layout-panel-kind={node.panel.kind}
    >
      {renderPanelByKind(node.panel.kind, {
        store,
        panelId,
        tabIds: panelTabIds,
        activeTabId: store.layout.getPanelActiveTabId(panelId),
        onSelectTab: (tabId) => store.layout.setPanelActiveTab(panelId, tabId),
        onRequestCloseTabs: (tabIds) => onRequestCloseTabsByKind(node.panel.kind, tabIds),
        onLayoutHeaderMouseDown: (event) => onHeaderMouseDown(panelId, event),
        onLayoutHeaderContextMenu: (event) => onHeaderContextMenu(panelId, event)
      })}
    </div>
  )
})

const SplitNodeView: React.FC<{
  node: LayoutSplitNode
  store: AppStore
  onHeaderMouseDown: (panelId: string, event: React.MouseEvent<HTMLElement>) => void
  onHeaderContextMenu: (panelId: string, event: React.MouseEvent<HTMLElement>) => void
  onRequestCloseTabsByKind: (kind: PanelKind, tabIds: string[]) => void
}> = observer(({ node, store, onHeaderMouseDown, onHeaderContextMenu, onRequestCloseTabsByKind }) => {
  const panelGroupRef = React.useRef<ImperativePanelGroupHandle | null>(null)
  const applyingLayoutRef = React.useRef(false)

  const parentRect = store.layout.geometry.nodeRects[node.id] || {
    left: 0,
    top: 0,
    width: store.layout.viewport.width,
    height: store.layout.viewport.height
  }

  const minPercentages = computeChildMinSizePercentages(node, parentRect, store.layout.viewport.height).map((value) =>
    Math.max(0, Math.min(100, value))
  )

  const sizeSignature = React.useMemo(() => node.sizes.map((size) => size.toFixed(3)).join(','), [node.sizes])
  const childSignature = React.useMemo(() => node.children.map((child) => child.id).join('|'), [node.children])

  React.useEffect(() => {
    const group = panelGroupRef.current
    if (!group?.setLayout) return

    applyingLayoutRef.current = true
    group.setLayout(node.sizes)
    requestAnimationFrame(() => {
      applyingLayoutRef.current = false
    })
  }, [sizeSignature, childSignature])

  return (
    <PanelGroup
      ref={panelGroupRef}
      direction={node.direction}
      className="gyshell-layout-split"
      onLayout={(sizes) => {
        if (applyingLayoutRef.current) {
          applyingLayoutRef.current = false
          return
        }
        store.layout.setSplitSizes(node.id, sizes)
      }}
    >
      {node.children.map((child, index) => {
        const defaultSize = node.sizes[index] ?? (100 / Math.max(1, node.children.length))
        const minSize = minPercentages[index] ?? 0
        return (
          <React.Fragment key={child.id}>
            <Panel id={child.id} order={index} defaultSize={defaultSize} minSize={minSize}>
              <LayoutNodeView
                node={child}
                store={store}
                onHeaderMouseDown={onHeaderMouseDown}
                onHeaderContextMenu={onHeaderContextMenu}
                onRequestCloseTabsByKind={onRequestCloseTabsByKind}
              />
            </Panel>
            {index < node.children.length - 1 ? <PanelResizeHandle className="gyshell-resize-handle" /> : null}
          </React.Fragment>
        )
      })}
    </PanelGroup>
  )
})

const LayoutNodeView: React.FC<{
  node: LayoutNode
  store: AppStore
  onHeaderMouseDown: (panelId: string, event: React.MouseEvent<HTMLElement>) => void
  onHeaderContextMenu: (panelId: string, event: React.MouseEvent<HTMLElement>) => void
  onRequestCloseTabsByKind: (kind: PanelKind, tabIds: string[]) => void
}> = ({ node, store, onHeaderMouseDown, onHeaderContextMenu, onRequestCloseTabsByKind }) => {
  if (node.type === 'panel') {
    return (
      <PanelLeaf
        node={node}
        store={store}
        onHeaderMouseDown={onHeaderMouseDown}
        onHeaderContextMenu={onHeaderContextMenu}
        onRequestCloseTabsByKind={onRequestCloseTabsByKind}
      />
    )
  }

  return (
    <SplitNodeView
      node={node}
      store={store}
      onHeaderMouseDown={onHeaderMouseDown}
      onHeaderContextMenu={onHeaderContextMenu}
      onRequestCloseTabsByKind={onRequestCloseTabsByKind}
    />
  )
}

const splitActions: Array<{
  action: LayoutMenuAction
  labelKey: LayoutMenuLabelKey
  direction: 'horizontal' | 'vertical'
  position: 'before' | 'after'
}> = [
  {
    action: 'split-up',
    labelKey: 'splitUp',
    direction: 'vertical',
    position: 'before'
  },
  {
    action: 'split-down',
    labelKey: 'splitDown',
    direction: 'vertical',
    position: 'after'
  },
  {
    action: 'split-left',
    labelKey: 'splitLeft',
    direction: 'horizontal',
    position: 'before'
  },
  {
    action: 'split-right',
    labelKey: 'splitRight',
    direction: 'horizontal',
    position: 'after'
  }
]

export const LayoutWorkspace: React.FC<LayoutWorkspaceProps> = observer(({ store }) => {
  const rootRef = React.useRef<HTMLDivElement | null>(null)
  const canvasRef = React.useRef<HTMLDivElement | null>(null)
  const menuRef = React.useRef<HTMLDivElement | null>(null)
  const trashRef = React.useRef<HTMLDivElement | null>(null)
  const isTrashHoverRef = React.useRef(false)
  const t = store.i18n.t
  const dragTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const [layoutMenu, setLayoutMenu] = React.useState<LayoutMenuState | null>(null)
  const [isTrashHover, setIsTrashHover] = React.useState(false)
  const [pendingTerminalCloseRequest, setPendingTerminalCloseRequest] = React.useState<PendingTerminalCloseRequest | null>(null)
  const [tabInsertIndicatorRect, setTabInsertIndicatorRect] = React.useState<LayoutRect | null>(null)

  const setSelectionSuppressed = React.useCallback((suppressed: boolean) => {
    document.body?.classList.toggle('chat-drag-selection-suppressed', suppressed)
  }, [])

  const setTrashHover = React.useCallback((value: boolean) => {
    isTrashHoverRef.current = value
    setIsTrashHover(value)
  }, [])

  const clearTabInsertIndicator = React.useCallback(() => {
    setTabInsertIndicatorRect(null)
  }, [])

  const normalizeClosableTabIds = React.useCallback(
    (kind: PanelKind, tabIds: string[]): string[] => {
      if (!getPanelKindAdapter(kind).supportsTabs || kind === 'filesystem') {
        return []
      }
      const ownerIds =
        kind === 'terminal'
          ? new Set(store.terminalTabs.map((tab) => tab.id))
          : new Set(store.chat.sessions.map((session) => session.id))
      const seen = new Set<string>()
      const next: string[] = []
      tabIds.forEach((tabId) => {
        if (!tabId || seen.has(tabId) || !ownerIds.has(tabId)) return
        seen.add(tabId)
        next.push(tabId)
      })
      return next
    },
    [store.chat.sessions, store.terminalTabs]
  )

  const requestCloseTabsByKind = React.useCallback(
    (kind: PanelKind, tabIds: string[]) => {
      if (!getPanelKindAdapter(kind).supportsTabs || kind === 'filesystem') return
      const ids = normalizeClosableTabIds(kind, tabIds)
      if (ids.length === 0) return
      if (kind === 'terminal') {
        setPendingTerminalCloseRequest({
          tabIds: ids
        })
        return
      }
      ids.forEach((sessionId) => {
        store.chat.closeSession(sessionId)
      })
    },
    [normalizeClosableTabIds, store.chat]
  )

  const requestClosePanel = React.useCallback(
    (panelId: string) => {
      if (!store.layout.canRemovePanel(panelId)) return
      const panelKind = store.layout.getPanelKindById(panelId)
      if (panelKind && !store.canClosePanel(panelKind)) {
        return
      }
      store.layout.removePanel(panelId)
      if (panelKind) {
        store.onPanelRemoved(panelKind)
      }
    },
    [store]
  )

  const terminalSignature = store.terminalTabs.map((tab) => tab.id).join('|')
  const chatSignature = store.chat.sessions.map((session) => session.id).join('|')

  React.useEffect(() => {
    store.layout.syncPanelBindings({ persist: false })
  }, [chatSignature, store.layout, terminalSignature])

  React.useEffect(() => {
    const element = canvasRef.current
    if (!element) return

    const updateViewport = () => {
      const bounds = element.getBoundingClientRect()
      store.layout.setViewport(bounds.width, bounds.height)
    }

    updateViewport()
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateViewport) : null
    observer?.observe(element)
    window.addEventListener('resize', updateViewport)

    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', updateViewport)
    }
  }, [store.layout])

  React.useEffect(() => {
    if (!layoutMenu) return

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (target && menuRef.current?.contains(target)) return
      setLayoutMenu(null)
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setLayoutMenu(null)
      }
    }

    window.addEventListener('mousedown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('mousedown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [layoutMenu])

  const isPointerOnTrash = React.useCallback((targetElement: HTMLElement | null, clientX: number, clientY: number): boolean => {
    const trashElement = trashRef.current
    if (!trashElement) return false
    if (targetElement && trashElement.contains(targetElement)) return true
    const rect = trashElement.getBoundingClientRect()
    return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom
  }, [])

  const resolveTabBarReorderHint = React.useCallback(
    (
      tabBarElement: HTMLElement,
      targetPanelId: string,
      draggingTabId: string,
      clientX: number
    ): {
      anchorTabId: string | null
      position: 'before' | 'after'
      indicatorRect: LayoutRect
    } | null => {
      const tabElements = Array.from(tabBarElement.querySelectorAll<HTMLElement>('[data-layout-tab-id]'))
        .filter((element) => element.getAttribute('data-layout-tab-panel-id') === targetPanelId)
        .map((element) => {
          const tabId = element.getAttribute('data-layout-tab-id')
          if (!tabId || tabId === draggingTabId) return null
          return {
            tabId,
            rect: element.getBoundingClientRect()
          }
        })
        .filter((entry): entry is { tabId: string; rect: DOMRect } => !!entry)
        .sort((a, b) => a.rect.left - b.rect.left)

      const tabBarRect = tabBarElement.getBoundingClientRect()
      const indicatorTop = tabBarRect.top + 4
      const indicatorHeight = Math.max(16, tabBarRect.height - 8)
      const buildIndicatorRect = (left: number): LayoutRect => ({
        left: Math.round(left - 1),
        top: Math.round(indicatorTop),
        width: 2,
        height: Math.round(indicatorHeight)
      })

      if (tabElements.length === 0) {
        return {
          anchorTabId: null,
          position: 'after',
          indicatorRect: buildIndicatorRect(tabBarRect.left + 8)
        }
      }

      const firstTab = tabElements[0]
      const firstTabMidX = firstTab.rect.left + firstTab.rect.width / 2
      if (clientX <= firstTabMidX) {
        return {
          anchorTabId: firstTab.tabId,
          position: 'before',
          indicatorRect: buildIndicatorRect(firstTab.rect.left)
        }
      }

      const lastTab = tabElements[tabElements.length - 1]
      const lastTabMidX = lastTab.rect.left + lastTab.rect.width / 2
      if (clientX >= lastTabMidX) {
        return {
          anchorTabId: lastTab.tabId,
          position: 'after',
          indicatorRect: buildIndicatorRect(lastTab.rect.right)
        }
      }

      const beforeTarget = tabElements.find((entry) => clientX < entry.rect.left + entry.rect.width / 2)
      if (!beforeTarget) {
        return {
          anchorTabId: lastTab.tabId,
          position: 'after',
          indicatorRect: buildIndicatorRect(lastTab.rect.right)
        }
      }

      return {
        anchorTabId: beforeTarget.tabId,
        position: 'before',
        indicatorRect: buildIndicatorRect(beforeTarget.rect.left)
      }
    },
    []
  )

  const updateDropTarget = React.useCallback(
    (targetElement: HTMLElement | null, clientX: number, clientY: number) => {
      const panelHost = targetElement?.closest?.('[data-layout-panel-id]') as HTMLElement | null
      const targetPanelId = panelHost?.getAttribute('data-layout-panel-id') || null
      const targetPanelKind = panelHost?.getAttribute('data-layout-panel-kind') as PanelKind | null

      if (store.layout.dragType === 'tab') {
        const draggingTab = store.layout.draggingTab
        const tabBarElement = targetElement?.closest?.('[data-layout-tab-bar="true"]') as HTMLElement | null
        const tabBarPanelId = tabBarElement?.getAttribute('data-layout-tab-panel-id') || null
        const tabBarKind = tabBarElement?.getAttribute('data-layout-tab-kind') as PanelKind | null

        if (draggingTab && tabBarElement && tabBarPanelId && tabBarKind === draggingTab.kind) {
          const reorderHint = resolveTabBarReorderHint(tabBarElement, tabBarPanelId, draggingTab.tabId, clientX)
          if (reorderHint) {
            store.layout.setTabReorderTarget(tabBarPanelId, reorderHint.anchorTabId, reorderHint.position)
            store.layout.setDropTarget(tabBarPanelId, 'center')
            setTabInsertIndicatorRect(reorderHint.indicatorRect)
            return
          }
        }
      }

      clearTabInsertIndicator()
      if (!panelHost || !targetPanelId) {
        store.layout.clearTabReorderTarget()
        store.layout.setDropTarget(null, null)
        return
      }

      if (store.layout.dragType === 'panel' && targetPanelId === store.layout.draggingPanelId) {
        store.layout.clearTabReorderTarget()
        store.layout.setDropTarget(null, null)
        return
      }

      const tabHost = (targetElement?.closest?.('[data-layout-tab-id]') as HTMLElement | null) || null
      if (store.layout.dragType === 'tab') {
        const draggingTab = store.layout.draggingTab
        if (!draggingTab || !targetPanelKind || targetPanelKind !== draggingTab.kind) {
          store.layout.clearTabReorderTarget()
          store.layout.setDropTarget(null, null)
          return
        }

        const targetTabId = tabHost?.getAttribute('data-layout-tab-id') || null
        const targetTabPanelId = tabHost?.getAttribute('data-layout-tab-panel-id') || null
        if (targetTabId && targetTabId === draggingTab.tabId) {
          store.layout.clearTabReorderTarget()
          store.layout.setDropTarget(null, null)
          return
        }
        if (
          tabHost &&
          targetTabId &&
          targetTabPanelId === targetPanelId &&
          targetTabId !== draggingTab.tabId
        ) {
          const tabRect = tabHost.getBoundingClientRect()
          const position = clientX < tabRect.left + tabRect.width / 2 ? 'before' : 'after'
          store.layout.setTabReorderTarget(targetPanelId, targetTabId, position)
          store.layout.setDropTarget(targetPanelId, 'center')
          return
        }
      }

      store.layout.clearTabReorderTarget()
      const rect = panelHost.getBoundingClientRect()
      const direction = determineDropDirection(
        {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height
        },
        clientX,
        clientY
      )
      store.layout.setDropTarget(targetPanelId, direction)
    },
    [clearTabInsertIndicator, resolveTabBarReorderHint, store.layout]
  )

  const handleHeaderMouseDown = React.useCallback(
    (panelId: string, event: React.MouseEvent<HTMLElement>) => {
      if (event.button !== 0) return
      if ((event.target as HTMLElement).closest('button')) return
      if ((event.target as HTMLElement).closest('[data-layout-tab-draggable="true"]')) return

      const startX = event.clientX
      const startY = event.clientY
      setSelectionSuppressed(true)

      dragTimerRef.current = setTimeout(() => {
        store.layout.startPanelDragging(panelId, startX, startY)
      }, 260)

      const handleMouseMove = (moveEvent: MouseEvent) => {
        store.layout.setDragPointer(moveEvent.clientX, moveEvent.clientY)
        if (!store.layout.isDragging) return

        const trashHover = isPointerOnTrash(moveEvent.target as HTMLElement | null, moveEvent.clientX, moveEvent.clientY)
        setTrashHover(trashHover)
        if (trashHover) {
          clearTabInsertIndicator()
          store.layout.clearTabReorderTarget()
          store.layout.setDropTarget(null, null)
          return
        }
        updateDropTarget(moveEvent.target as HTMLElement | null, moveEvent.clientX, moveEvent.clientY)
      }

      const handleMouseUp = () => {
        if (dragTimerRef.current) {
          clearTimeout(dragTimerRef.current)
          dragTimerRef.current = null
        }

        setSelectionSuppressed(false)
        if (
          store.layout.isDragging &&
          store.layout.dragType === 'panel' &&
          isTrashHoverRef.current &&
          store.layout.draggingPanelId
        ) {
          const draggedPanelId = store.layout.draggingPanelId
          store.layout.clearDragging()
          requestClosePanel(draggedPanelId)
        } else if (store.layout.isDragging) {
          store.layout.commitDragging()
        } else {
          store.layout.clearDragging()
        }

        setTrashHover(false)
        clearTabInsertIndicator()
        window.removeEventListener('mousemove', handleMouseMove)
        window.removeEventListener('mouseup', handleMouseUp)
      }

      window.addEventListener('mousemove', handleMouseMove)
      window.addEventListener('mouseup', handleMouseUp)
    },
    [clearTabInsertIndicator, isPointerOnTrash, requestClosePanel, setSelectionSuppressed, setTrashHover, store.layout, updateDropTarget]
  )

  React.useEffect(() => {
    const host = rootRef.current
    if (!host) return

    const readPayload = (target: EventTarget | null): TabDragPayload | null => {
      const tabElement = (target as HTMLElement | null)?.closest?.('[data-layout-tab-id]') as HTMLElement | null
      if (!tabElement) return null
      const tabId = tabElement.getAttribute('data-layout-tab-id')
      const kind = tabElement.getAttribute('data-layout-tab-kind')
      const sourcePanelId = tabElement.getAttribute('data-layout-tab-panel-id')
      if (!tabId || !sourcePanelId || (kind !== 'chat' && kind !== 'terminal' && kind !== 'filesystem' && kind !== 'fileEditor')) {
        return null
      }
      if (!getPanelKindAdapter(kind).supportsTabs) {
        return null
      }
      return {
        tabId,
        kind,
        sourcePanelId
      }
    }

    const clearDropPreview = () => {
      clearTabInsertIndicator()
      store.layout.clearTabReorderTarget()
      store.layout.setDropTarget(null, null)
    }

    const handleDragStart = (event: DragEvent) => {
      const payload = readPayload(event.target)
      if (!payload) return
      event.dataTransfer?.setData('text/plain', payload.tabId)
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move'
      }
      setSelectionSuppressed(true)
      clearTabInsertIndicator()
      store.layout.startTabDragging(payload, event.clientX, event.clientY)
    }

    const handleDragOver = (event: DragEvent) => {
      if (!store.layout.isDragging || store.layout.dragType !== 'tab') return
      event.preventDefault()
      store.layout.setDragPointer(event.clientX, event.clientY)

      const trashHover = isPointerOnTrash(event.target as HTMLElement | null, event.clientX, event.clientY)
      setTrashHover(trashHover)
      if (trashHover) {
        clearDropPreview()
        if (event.dataTransfer) {
          event.dataTransfer.dropEffect = 'move'
        }
        return
      }

      updateDropTarget(event.target as HTMLElement | null, event.clientX, event.clientY)
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = store.layout.dropTargetPanelId ? 'move' : 'none'
      }
    }

    const handleDragLeave = (event: DragEvent) => {
      if (!store.layout.isDragging || store.layout.dragType !== 'tab') return
      const rect = host.getBoundingClientRect()
      const outside =
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      if (!outside) return
      clearDropPreview()
      setTrashHover(false)
    }

    const handleDrop = (event: DragEvent) => {
      if (!store.layout.isDragging || store.layout.dragType !== 'tab') return
      event.preventDefault()
      store.layout.setDragPointer(event.clientX, event.clientY)
      const draggingTab = store.layout.draggingTab
      const trashHover = isPointerOnTrash(event.target as HTMLElement | null, event.clientX, event.clientY)
      if (trashHover && draggingTab) {
        store.layout.clearDragging()
        setSelectionSuppressed(false)
        setTrashHover(false)
        clearTabInsertIndicator()
        requestCloseTabsByKind(draggingTab.kind, [draggingTab.tabId])
        return
      }

      updateDropTarget(event.target as HTMLElement | null, event.clientX, event.clientY)
      store.layout.commitDragging()
      setSelectionSuppressed(false)
      setTrashHover(false)
      clearTabInsertIndicator()
    }

    const handleDragEnd = () => {
      if (!store.layout.isDragging || store.layout.dragType !== 'tab') return
      store.layout.clearDragging()
      setSelectionSuppressed(false)
      setTrashHover(false)
      clearTabInsertIndicator()
    }

    const handleWindowDragOver = (event: DragEvent) => {
      if (!store.layout.isDragging || store.layout.dragType !== 'tab') return
      const rect = host.getBoundingClientRect()
      const inside =
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom
      if (inside) return
      clearDropPreview()
      setTrashHover(false)
    }

    host.addEventListener('dragstart', handleDragStart)
    host.addEventListener('dragover', handleDragOver)
    host.addEventListener('dragleave', handleDragLeave)
    host.addEventListener('drop', handleDrop)
    host.addEventListener('dragend', handleDragEnd)
    window.addEventListener('dragover', handleWindowDragOver)

    return () => {
      host.removeEventListener('dragstart', handleDragStart)
      host.removeEventListener('dragover', handleDragOver)
      host.removeEventListener('dragleave', handleDragLeave)
      host.removeEventListener('drop', handleDrop)
      host.removeEventListener('dragend', handleDragEnd)
      window.removeEventListener('dragover', handleWindowDragOver)
    }
  }, [clearTabInsertIndicator, isPointerOnTrash, requestCloseTabsByKind, setSelectionSuppressed, setTrashHover, store.layout, updateDropTarget])

  const handleHeaderContextMenu = React.useCallback((panelId: string, event: React.MouseEvent<HTMLElement>) => {
    event.preventDefault()
    const panelKind = store.layout.getPanelKindById(panelId)
    if (!panelKind) return
    const tabElement = (event.target as HTMLElement | null)?.closest?.('[data-layout-tab-id]') as HTMLElement | null
    const targetTabId = tabElement?.getAttribute('data-layout-tab-id') || null
    const targetTabPanelId = tabElement?.getAttribute('data-layout-tab-panel-id') || null
    const mode: LayoutMenuMode = targetTabId && targetTabPanelId === panelId ? 'tab' : 'bar'
    setLayoutMenu({
      panelId,
      panelKind,
      mode,
      targetTabId: mode === 'tab' ? targetTabId : null,
      x: event.clientX,
      y: event.clientY
    })
  }, [store.layout])

  React.useEffect(() => {
    return () => {
      if (dragTimerRef.current) {
        clearTimeout(dragTimerRef.current)
        dragTimerRef.current = null
      }
      setSelectionSuppressed(false)
      setTrashHover(false)
      clearTabInsertIndicator()
      store.layout.clearDragging()
    }
  }, [clearTabInsertIndicator, setSelectionSuppressed, setTrashHover, store.layout])

  const menuTabIds = layoutMenu ? store.layout.getPanelTabIds(layoutMenu.panelId) : []
  const menuItems: Array<{
    action: LayoutMenuAction
    labelKey: LayoutMenuLabelKey
    danger?: boolean
    disabled?: boolean
  }> = (() => {
    if (!layoutMenu) return []
    const canSplit = store.layout.panelCount < MAX_LAYOUT_PANELS
    const canClosePanel = store.layout.canRemovePanel(layoutMenu.panelId)
    const canCloseTabs = getPanelKindAdapter(layoutMenu.panelKind).supportsTabs && layoutMenu.panelKind !== 'filesystem'

    if (layoutMenu.mode === 'bar') {
      const items: Array<{
        action: LayoutMenuAction
        labelKey: LayoutMenuLabelKey
        danger?: boolean
        disabled?: boolean
      }> = [
        {
          action: 'close-panel',
          labelKey: 'closePanel',
          danger: true,
          disabled: !canClosePanel
        }
      ]
      if (canCloseTabs) {
        items.push({
          action: 'close-all-tabs',
          labelKey: 'closeAllTabs',
          danger: true,
          disabled: menuTabIds.length === 0
        })
      }
      return items
    }

    const hasTargetTab = !!layoutMenu.targetTabId && menuTabIds.includes(layoutMenu.targetTabId)
    const closeItems: Array<{
      action: LayoutMenuAction
      labelKey: LayoutMenuLabelKey
      danger?: boolean
      disabled?: boolean
    }> = [
      {
        action: 'close-tab',
        labelKey: 'closeTab',
        danger: true,
        disabled: !canCloseTabs || !hasTargetTab
      },
      {
        action: 'close-other-tabs',
        labelKey: 'closeOtherTabs',
        danger: true,
        disabled: !canCloseTabs || !hasTargetTab || menuTabIds.length <= 1
      },
      {
        action: 'close-all-tabs',
        labelKey: 'closeAllTabs',
        danger: true,
        disabled: !canCloseTabs || menuTabIds.length === 0
      }
    ]

    const splitItems = splitActions.map((entry) => ({
      action: entry.action,
      labelKey: entry.labelKey,
      disabled: !canSplit || !hasTargetTab
    }))

    return [
      ...closeItems,
      ...splitItems,
      {
        action: 'close-panel',
        labelKey: 'closePanel',
        danger: true,
        disabled: !canClosePanel
      }
    ]
  })()

  const runMenuAction = React.useCallback((action: LayoutMenuAction) => {
    if (!layoutMenu) return
    const panelTabIds = store.layout.getPanelTabIds(layoutMenu.panelId)

    if (action === 'close-tab' && layoutMenu.targetTabId) {
      requestCloseTabsByKind(layoutMenu.panelKind, [layoutMenu.targetTabId])
      setLayoutMenu(null)
      return
    }

    if (action === 'close-other-tabs' && layoutMenu.targetTabId) {
      requestCloseTabsByKind(
        layoutMenu.panelKind,
        panelTabIds.filter((tabId) => tabId !== layoutMenu.targetTabId)
      )
      setLayoutMenu(null)
      return
    }

    if (action === 'close-all-tabs') {
      requestCloseTabsByKind(layoutMenu.panelKind, panelTabIds)
      setLayoutMenu(null)
      return
    }

    const splitEntry = splitActions.find((entry) => entry.action === action)
    if (splitEntry) {
      const dropDirection =
        splitEntry.direction === 'horizontal'
          ? splitEntry.position === 'before'
            ? 'left'
            : 'right'
          : splitEntry.position === 'before'
            ? 'top'
            : 'bottom'

      if (layoutMenu.mode === 'tab' && layoutMenu.targetTabId) {
        store.layout.splitTabToDirection(
          {
            tabId: layoutMenu.targetTabId,
            kind: layoutMenu.panelKind,
            sourcePanelId: layoutMenu.panelId
          },
          layoutMenu.panelId,
          dropDirection
        )
      }
      setLayoutMenu(null)
      return
    }

    if (action === 'close-panel') {
      requestClosePanel(layoutMenu.panelId)
      setLayoutMenu(null)
    }
  }, [layoutMenu, requestClosePanel, requestCloseTabsByKind, store.layout])

  const targetRect = store.layout.dropTargetPanelId
    ? store.layout.getPanelRect(store.layout.dropTargetPanelId)
    : null

  const pendingTerminalCloseCount = pendingTerminalCloseRequest?.tabIds.length || 0

  return (
    <div ref={rootRef} className="gyshell-layout-root">
      <PanelTypeRail store={store} />
      <div ref={canvasRef} className="gyshell-layout-canvas">
        <ConfirmDialog
          open={pendingTerminalCloseCount > 0}
          title={t.terminal.confirmCloseTitle}
          message={
            pendingTerminalCloseCount > 1
              ? t.terminal.confirmCloseManyMessage(pendingTerminalCloseCount)
              : t.terminal.confirmCloseMessage
          }
          confirmText={t.common.close}
          cancelText={t.common.cancel}
          danger
          onCancel={() => setPendingTerminalCloseRequest(null)}
          onConfirm={() => {
            const request = pendingTerminalCloseRequest
            if (!request) return
            setPendingTerminalCloseRequest(null)
            void (async () => {
              for (const tabId of request.tabIds) {
                await store.closeTab(tabId)
              }
            })()
          }}
        />

        <LayoutNodeView
          node={store.layout.tree.root}
          store={store}
          onHeaderMouseDown={handleHeaderMouseDown}
          onHeaderContextMenu={handleHeaderContextMenu}
          onRequestCloseTabsByKind={requestCloseTabsByKind}
        />

        {store.layout.isDragging ? (
          <DragOverlay
            targetRect={targetRect}
            previewRect={store.layout.dropPreviewRect}
          />
        ) : null}

        {store.layout.isDragging && store.layout.dragType === 'tab' && tabInsertIndicatorRect ? (
          <div
            className="gyshell-layout-tab-insert-indicator"
            style={{
              left: tabInsertIndicatorRect.left,
              top: tabInsertIndicatorRect.top,
              height: tabInsertIndicatorRect.height
            }}
          />
        ) : null}

        {store.layout.isDragging ? (
          <div
            ref={trashRef}
            className={clsx('gyshell-layout-trash-drop', {
              'is-hot': isTrashHover
            })}
            data-layout-trash-drop="true"
          >
            <Trash2 size={16} strokeWidth={2.2} />
          </div>
        ) : null}

        {layoutMenu ? (
          <div
            ref={menuRef}
            className="gyshell-layout-menu"
            style={{ left: layoutMenu.x, top: layoutMenu.y }}
          >
            {menuItems.map((item) => (
              <button
                key={item.action}
                className={clsx('gyshell-layout-menu-item', {
                  'is-danger': item.danger,
                  'is-disabled': item.disabled
                })}
                disabled={item.disabled}
                onClick={() => runMenuAction(item.action)}
              >
                {t.layout[item.labelKey]}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
})
