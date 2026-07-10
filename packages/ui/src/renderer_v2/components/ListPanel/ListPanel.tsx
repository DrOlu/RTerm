import React from "react";
import clsx from "clsx";
import { observer } from "mobx-react-lite";
import {
  GripVertical,
  MessageSquare,
  Plus,
  SquareTerminal,
  X,
} from "lucide-react";
import type { AppStore, TerminalTabModel } from "../../stores/AppStore";
import type { ChatSession } from "../../stores/ChatStore";
import type { TabDragPayload } from "../../layout";
import {
  getTerminalConnectionIconKind,
  resolveTerminalRuntimeIndicatorState,
} from "../../lib/terminalConnectionModel";
import { normalizeSessionTitleText } from "../../lib/sessionTitleDisplay";
import { TerminalAddButton } from "../Terminal/TerminalAddButton";
import { resolveTerminalTabIcon } from "../Terminal/terminalTabIcons";
import {
  buildListPanelRows,
  resolveCreatedTerminalTabActivation,
  resolveListPanelChatStatusLabel,
  resolveListPanelRowActivation,
  type ListPanelRow,
  type ListPanelTabKind,
  type ListPanelTabSource,
} from "./listPanelModel";
import "./listPanel.scss";

interface ListPanelProps {
  store: AppStore;
  panelId: string;
  onRequestCloseTabsByKind?: (
    kind: ListPanelTabKind,
    tabIds: string[],
  ) => void;
  onRequestOpenTabInDetachedWindow?: (payload: TabDragPayload) => void;
  onLayoutHeaderContextMenu?: (event: React.MouseEvent<HTMLElement>) => void;
}

const getTerminalSubtitle = (
  store: AppStore,
  tab: TerminalTabModel,
): string => {
  const configType = String((tab.config as { type?: string }).type || "");
  if (configType === "local") {
    return store.i18n.t.terminal.local;
  }
  if (configType === "ssh") {
    return "SSH";
  }
  return configType || tab.id;
};

const buildTerminalSources = (store: AppStore): ListPanelTabSource[] =>
  store.terminalTabs.map((tab, index) => ({
    id: tab.id,
    kind: "terminal",
    title: tab.title || tab.config.title || tab.id,
    subtitle: getTerminalSubtitle(store, tab),
    statusLabel: tab.runtimeState || "initializing",
    updatedAt: index,
  }));

interface ChatSourceLabels {
  messages: (count: number) => string;
  running: string;
  ready: string;
}

const buildChatSources = (
  sessions: readonly ChatSession[],
  labels: ChatSourceLabels,
): ListPanelTabSource[] =>
  sessions.map((session, index) => {
    const lastMessageId = session.messageIds[session.messageIds.length - 1];
    const lastMessageTimestamp = lastMessageId
      ? session.messagesById.get(lastMessageId)?.timestamp
      : undefined;
    return {
      id: session.id,
      kind: "chat",
      title: normalizeSessionTitleText(session.title),
      subtitle:
        session.messageIds.length > 0
          ? labels.messages(session.messageIds.length)
          : session.isSessionBusy
            ? labels.running
            : labels.ready,
      statusLabel: resolveListPanelChatStatusLabel(session.isSessionBusy),
      updatedAt: Number.isFinite(lastMessageTimestamp)
        ? lastMessageTimestamp
        : Number.MAX_SAFE_INTEGER - (sessions.length - index),
    };
  });

const getTerminalStatusClassName = (
  store: AppStore,
  row: ListPanelRow,
): string => {
  const tab = store.terminalTabs.find((entry) => entry.id === row.id);
  if (!tab) return "inactive";
  return resolveTerminalRuntimeIndicatorState(
    tab.config.type,
    tab.runtimeState || "initializing",
  );
};

const renderRowIcon = (store: AppStore, row: ListPanelRow): React.ReactNode => {
  if (row.kind === "chat") {
    return <MessageSquare size={15} strokeWidth={2.1} />;
  }
  const tab = store.terminalTabs.find((entry) => entry.id === row.id);
  const iconKind = tab
    ? getTerminalConnectionIconKind(tab.config.type)
    : "generic";
  const Icon = resolveTerminalTabIcon(iconKind);
  return <Icon size={15} strokeWidth={2.1} />;
};

export const ListPanel: React.FC<ListPanelProps> = observer(
  ({
    store,
    panelId,
    onRequestCloseTabsByKind,
    onRequestOpenTabInDetachedWindow,
    onLayoutHeaderContextMenu,
  }) => {
    const [mode, setMode] = React.useState<ListPanelTabKind>("terminal");
    const t = store.i18n.t;
    const isLayoutDragSource =
      store.layout.isDragging && store.layout.draggingPanelId === panelId;

    const terminalRows = buildListPanelRows({
      sources: buildTerminalSources(store),
      visibleTabIds: store.getOwnedTabIds("terminal"),
      panelIds: store.layout.getPanelIdsByKind("terminal"),
      getPanelTabIds: (targetPanelId) =>
        store.layout.getPanelTabIds(targetPanelId),
      getPanelActiveTabId: (targetPanelId) =>
        store.layout.getPanelActiveTabId(targetPanelId),
      globalActiveTabId: store.activeTerminalId || null,
    });

    const chatRows = buildListPanelRows({
      sources: buildChatSources(store.chat.sessions, {
        messages: t.layout.listPanelChatMessages,
        running: t.layout.listPanelChatRunning,
        ready: t.layout.listPanelChatReady,
      }),
      visibleTabIds: store.getOwnedTabIds("chat"),
      panelIds: store.layout.getPanelIdsByKind("chat"),
      getPanelTabIds: (targetPanelId) =>
        store.layout.getPanelTabIds(targetPanelId),
      getPanelActiveTabId: (targetPanelId) =>
        store.layout.getPanelActiveTabId(targetPanelId),
      globalActiveTabId: store.chat.activeSessionId || null,
    });

    const rows = mode === "terminal" ? terminalRows : chatRows;
    const emptyLabel =
      mode === "terminal" ? t.layout.emptyTerminalTabs : t.layout.emptyChatTabs;

    const terminalAddTargetPanelId =
      store.layout.getPrimaryPanelId("terminal") || undefined;

    const openTabInPrimaryPanel = React.useCallback(
      (kind: ListPanelTabKind, tabId: string, hostPanelId?: string | null) => {
        const targetPanelId =
          hostPanelId ||
          store.layout.getPrimaryPanelId(kind) ||
          store.layout.ensurePrimaryPanelForKind(kind);
        if (!targetPanelId) {
          onRequestOpenTabInDetachedWindow?.({
            tabId,
            kind,
            sourcePanelId: hostPanelId || panelId,
          });
          return;
        }
        store.layout.attachTabToPanel(kind, tabId, targetPanelId);
        store.layout.setPanelActiveTab(targetPanelId, tabId);
      },
      [onRequestOpenTabInDetachedWindow, panelId, store.layout],
    );

    const handleAddChat = React.useCallback(() => {
      const sessionId = store.chat.createSession();
      openTabInPrimaryPanel("chat", sessionId);
    }, [openTabInPrimaryPanel, store.chat]);

    const handleOpenRow = React.useCallback(
      (row: ListPanelRow) => {
        openTabInPrimaryPanel(row.kind, row.id, row.host?.panelId);
      },
      [openTabInPrimaryPanel],
    );

    const handleActivateRow = React.useCallback(
      (row: ListPanelRow) => {
        const activation = resolveListPanelRowActivation(row);
        if (activation.type === "select") {
          store.layout.setPanelActiveTab(activation.panelId, activation.tabId);
          return;
        }
        openTabInPrimaryPanel(
          activation.kind,
          activation.tabId,
          activation.hostPanelId,
        );
      },
      [openTabInPrimaryPanel, store.layout],
    );

    const handleTerminalTabCreated = React.useCallback(
      (tabId: string) => {
        const activation = resolveCreatedTerminalTabActivation({
          tabId,
          hostPanelId: store.layout.getPrimaryPanelId("terminal"),
        });
        if (activation.type === "none") {
          return;
        }
        store.layout.setPanelActiveTab(activation.panelId, activation.tabId);
      },
      [store.layout],
    );

    const handleCloseRow = React.useCallback(
      (row: ListPanelRow) => {
        if (onRequestCloseTabsByKind) {
          onRequestCloseTabsByKind(row.kind, [row.id]);
          return;
        }
        if (row.kind === "terminal") {
          void store.closeTab(row.id);
          return;
        }
        store.chat.closeSession(row.id);
      },
      [onRequestCloseTabsByKind, store],
    );

    const handlePanelMouseDownCapture = React.useCallback(() => {
      if (store.layout.tree.focusedPanelId !== panelId) {
        store.layout.setFocusedPanel(panelId);
      }
    }, [panelId, store.layout]);

    const renderRow = (row: ListPanelRow): React.ReactNode => {
      const statusClassName =
        row.kind === "terminal"
          ? getTerminalStatusClassName(store, row)
          : row.statusLabel;
      const tooltip = row.host
        ? `${row.title} · panel ${row.host.panelIndex + 1}`
        : row.title;
      return (
        <div
          key={row.id}
          className={clsx("list-panel-row", {
            "is-active": row.active,
          })}
          role="button"
          tabIndex={0}
          draggable={row.canDrag}
          title={tooltip}
          onClick={() => handleActivateRow(row)}
          onDoubleClick={(event) => {
            event.preventDefault();
            handleOpenRow(row);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            handleActivateRow(row);
          }}
          data-layout-tab-draggable="true"
          data-layout-tab-id={row.id}
          data-layout-tab-kind={row.kind}
          data-layout-tab-panel-id={row.host?.panelId || panelId}
          data-layout-tab-index={row.host?.tabIndex || 0}
        >
          <div className="list-panel-row-accent" aria-hidden="true" />
          <div className="list-panel-row-icon" aria-hidden="true">
            {renderRowIcon(store, row)}
          </div>
          <div className="list-panel-row-text">
            <div className="list-panel-row-title">{row.title}</div>
            <div className="list-panel-row-subtitle">
              <span
                className={`list-panel-status-dot is-${statusClassName}`}
                aria-hidden="true"
              />
              <span>{row.subtitle}</span>
            </div>
          </div>
          <button
            type="button"
            className="list-panel-row-close"
            title={t.common.close}
            aria-label={t.common.close}
            onClick={(event) => {
              event.stopPropagation();
              handleCloseRow(row);
            }}
          >
            <X size={13} strokeWidth={2.2} />
          </button>
        </div>
      );
    };

    return (
      <div
        className={clsx("panel panel-list-panel", {
          "is-dragging-source": isLayoutDragSource,
        })}
        onMouseDownCapture={handlePanelMouseDownCapture}
      >
        <div
          className="list-panel-header is-draggable"
          draggable
          data-layout-panel-draggable="true"
          data-layout-panel-id={panelId}
          data-layout-panel-kind="listPanel"
          onContextMenu={onLayoutHeaderContextMenu}
        >
          <div className="panel-tab-drag-handle" aria-hidden="true">
            <GripVertical size={12} strokeWidth={2.4} />
          </div>
          <span className="list-panel-header-title">
            {t.layout.listPanelKind}
          </span>
        </div>

        <div className="list-panel-modebar">
          <div
            className="list-panel-mode-tabs"
            role="tablist"
            aria-label={t.layout.listPanelKind}
          >
            <button
              type="button"
              className={clsx("list-panel-mode-tab", {
                "is-active": mode === "terminal",
              })}
              role="tab"
              aria-selected={mode === "terminal"}
              onClick={() => setMode("terminal")}
            >
              <SquareTerminal size={14} strokeWidth={2.1} />
              <span className="list-panel-mode-label">
                {t.layout.terminalKind}
              </span>
              <span className="list-panel-mode-count">
                {terminalRows.length}
              </span>
            </button>
            <button
              type="button"
              className={clsx("list-panel-mode-tab", {
                "is-active": mode === "chat",
              })}
              role="tab"
              aria-selected={mode === "chat"}
              onClick={() => setMode("chat")}
            >
              <MessageSquare size={14} strokeWidth={2.1} />
              <span className="list-panel-mode-label">{t.layout.chatKind}</span>
              <span className="list-panel-mode-count">{chatRows.length}</span>
            </button>
          </div>
          {mode === "terminal" ? (
            <TerminalAddButton
              store={store}
              targetPanelId={terminalAddTargetPanelId}
              ensurePanelOnCreate={false}
              className="list-panel-add"
              title={t.layout.addTerminalTab}
              ariaLabel={t.layout.addTerminalTab}
              onTabCreated={handleTerminalTabCreated}
              createSshInBackground
            />
          ) : (
            <button
              type="button"
              className="list-panel-add"
              title={t.layout.addChatSession}
              aria-label={t.layout.addChatSession}
              onClick={handleAddChat}
            >
              <Plus size={14} strokeWidth={2.2} />
            </button>
          )}
        </div>

        <div className="list-panel-body" data-list-panel-mode={mode}>
          {rows.length > 0 ? (
            rows.map((row) => renderRow(row))
          ) : (
            <div className="list-panel-empty">{emptyLabel}</div>
          )}
        </div>
      </div>
    );
  },
);
