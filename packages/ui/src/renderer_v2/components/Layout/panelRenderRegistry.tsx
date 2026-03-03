import React from 'react'
import type { AppStore } from '../../stores/AppStore'
import { ChatPanel } from '../Chat/ChatPanel'
import { TerminalPanel } from '../Terminal/TerminalPanel'
import { FileSystemPanel } from '../FileSystem/FileSystemPanel'
import { FileEditorPanel } from '../FileSystem/FileEditorPanel'
import type { PanelKind } from '../../layout'

export interface LayoutPanelRenderProps {
  store: AppStore
  panelId: string
  tabIds: string[]
  activeTabId: string | null
  onSelectTab: (tabId: string) => void
  onRequestCloseTabs?: (tabIds: string[]) => void
  onLayoutHeaderMouseDown?: (event: React.MouseEvent<HTMLElement>) => void
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
  onLayoutHeaderMouseDown,
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
    onLayoutHeaderMouseDown={onLayoutHeaderMouseDown}
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
  onLayoutHeaderMouseDown,
  onLayoutHeaderContextMenu
}) => (
  <ChatPanel
    store={store}
    panelId={panelId}
    sessionIds={tabIds}
    activeSessionId={activeTabId}
    onSelectSession={onSelectTab}
    onRequestCloseTabs={onRequestCloseTabs}
    onLayoutHeaderMouseDown={onLayoutHeaderMouseDown}
    onLayoutHeaderContextMenu={onLayoutHeaderContextMenu}
  />
)

const FileSystemPanelRenderer: LayoutPanelRenderer = ({
  store,
  panelId,
  tabIds,
  activeTabId,
  onSelectTab,
  onLayoutHeaderMouseDown,
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
    onLayoutHeaderMouseDown={onLayoutHeaderMouseDown}
    onLayoutHeaderContextMenu={onLayoutHeaderContextMenu}
  />
)

const FileEditorPanelRenderer: LayoutPanelRenderer = ({
  store,
  panelId,
  onLayoutHeaderMouseDown,
  onLayoutHeaderContextMenu
}) => (
  <FileEditorPanel
    store={store}
    panelId={panelId}
    onLayoutHeaderMouseDown={onLayoutHeaderMouseDown}
    onLayoutHeaderContextMenu={onLayoutHeaderContextMenu}
  />
)

const PANEL_RENDERERS: Record<PanelKind, LayoutPanelRenderer> = {
  terminal: TerminalPanelRenderer,
  chat: ChatPanelRenderer,
  filesystem: FileSystemPanelRenderer,
  fileEditor: FileEditorPanelRenderer
}

export const renderPanelByKind = (
  kind: PanelKind,
  props: LayoutPanelRenderProps
): React.ReactElement => {
  const Renderer = PANEL_RENDERERS[kind]
  return <Renderer {...props} />
}
