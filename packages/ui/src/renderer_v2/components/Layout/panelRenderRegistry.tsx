import React from 'react'
import type { AppStore } from '../../stores/AppStore'
import { ChatPanel } from '../Chat/ChatPanel'
import { TerminalPanel } from '../Terminal/TerminalPanel'
import { FileSystemPanel } from '../FileSystem/FileSystemPanel'
import { FileEditorPanel } from '../FileSystem/FileEditorPanel'
import { MonitorPanel } from '../Monitor/MonitorPanel'
import { ListPanel } from '../ListPanel/ListPanel'
import type { PanelKind, TabDragPayload } from '../../layout'

export interface LayoutPanelRenderProps {
  store: AppStore
  panelId: string
  tabIds: string[]
  activeTabId: string | null
  onSelectTab: (tabId: string) => void
  onRequestCloseTabs?: (tabIds: string[]) => void
  onRequestCloseTabsByKind?: (kind: PanelKind, tabIds: string[]) => void
  onRequestOpenTabInDetachedWindow?: (payload: TabDragPayload) => void
  onLayoutHeaderContextMenu?: (event: React.MouseEvent<HTMLElement>) => void
}

type LayoutPanelRenderer = React.FC<LayoutPanelRenderProps>

const TerminalPanelRenderer: LayoutPanelRenderer = ({
  store,
  panelId,
  tabIds,
  activeTabId,
  onSelectTab,
  onRequestCloseTabs,
  onLayoutHeaderContextMenu
}) => (
  <TerminalPanel
    store={store}
    panelId={panelId}
    tabs={tabIds
      .map((tabId) => store.terminalTabs.find((tab) => tab.id === tabId))
      .filter((tab): tab is NonNullable<typeof tab> => !!tab)}
    activeTabId={activeTabId}
    onSelectTab={onSelectTab}
    onRequestCloseTabs={onRequestCloseTabs}
    onLayoutHeaderContextMenu={onLayoutHeaderContextMenu}
  />
)

const ChatPanelRenderer: LayoutPanelRenderer = ({
  store,
  panelId,
  tabIds,
  activeTabId,
  onSelectTab,
  onRequestCloseTabs,
  onLayoutHeaderContextMenu
}) => (
  <ChatPanel
    store={store}
    panelId={panelId}
    sessionIds={tabIds}
    activeSessionId={activeTabId}
    onSelectSession={onSelectTab}
    onRequestCloseTabs={onRequestCloseTabs}
    onLayoutHeaderContextMenu={onLayoutHeaderContextMenu}
  />
)

const FileSystemPanelRenderer: LayoutPanelRenderer = ({
  store,
  panelId,
  tabIds,
  activeTabId,
  onSelectTab,
  onLayoutHeaderContextMenu
}) => (
  <FileSystemPanel
    store={store}
    panelId={panelId}
    tabs={tabIds
      .map((tabId) => store.fileSystemTabs.find((tab) => tab.id === tabId))
      .filter((tab): tab is NonNullable<typeof tab> => !!tab)}
    activeTabId={activeTabId}
    onSelectTab={onSelectTab}
    onLayoutHeaderContextMenu={onLayoutHeaderContextMenu}
  />
)

const FileEditorPanelRenderer: LayoutPanelRenderer = ({
  store,
  panelId,
  onLayoutHeaderContextMenu
}) => (
  <FileEditorPanel
    store={store}
    panelId={panelId}
    onLayoutHeaderContextMenu={onLayoutHeaderContextMenu}
  />
)

const MonitorPanelRenderer: LayoutPanelRenderer = ({
  store,
  panelId,
  tabIds,
  activeTabId,
  onSelectTab,
  onLayoutHeaderContextMenu
}) => (
  <MonitorPanel
    store={store}
    panelId={panelId}
    tabs={tabIds
      .map((tabId) => store.monitorTabs.find((tab) => tab.id === tabId))
      .filter((tab): tab is NonNullable<typeof tab> => !!tab)}
    activeTabId={activeTabId}
    onSelectTab={onSelectTab}
    onLayoutHeaderContextMenu={onLayoutHeaderContextMenu}
  />
)

const ListPanelRenderer: LayoutPanelRenderer = ({
  store,
  panelId,
  onRequestCloseTabsByKind,
  onRequestOpenTabInDetachedWindow,
  onLayoutHeaderContextMenu
}) => (
  <ListPanel
    store={store}
    panelId={panelId}
    onRequestCloseTabsByKind={onRequestCloseTabsByKind}
    onRequestOpenTabInDetachedWindow={onRequestOpenTabInDetachedWindow}
    onLayoutHeaderContextMenu={onLayoutHeaderContextMenu}
  />
)

const PANEL_RENDERERS: Record<PanelKind, LayoutPanelRenderer> = {
  terminal: TerminalPanelRenderer,
  chat: ChatPanelRenderer,
  filesystem: FileSystemPanelRenderer,
  fileEditor: FileEditorPanelRenderer,
  monitor: MonitorPanelRenderer,
  listPanel: ListPanelRenderer
}

export const renderPanelByKind = (
  kind: PanelKind,
  props: LayoutPanelRenderProps
): React.ReactElement => {
  const Renderer = PANEL_RENDERERS[kind]
  return <Renderer {...props} />
}
