import React from "react";
import { createPortal } from "react-dom";
import { GripVertical, Laptop, Plus, Server, X } from "lucide-react";
import { observer } from "mobx-react-lite";
import type { AppStore, TerminalTabModel } from "../../stores/AppStore";
import "./terminal.scss";
import { XTermView } from "./XTermView";
import { resolveFloatingMenuPlacement } from "../../lib/menuPlacement";
import {
  getTerminalConnectionIconKind,
  resolveTerminalRuntimeIndicatorState,
} from "../../lib/terminalConnectionModel";
import { isLinux, isWindows } from "../../platform/platform";
import { CompactPanelTabSelect } from "../Layout/CompactPanelTabSelect";
import { resolvePanelTabBarMode } from "../Layout/panelHeaderPresentation";
import { resolveTerminalTabIcon } from "./terminalTabIcons";

interface TerminalPanelProps {
  store: AppStore;
  panelId: string;
  tabs: TerminalTabModel[];
  activeTabId: string | null;
  onSelectTab: (tabId: string) => void;
  onRequestCloseTabs?: (tabIds: string[]) => void;
  onLayoutHeaderContextMenu?: (event: React.MouseEvent<HTMLElement>) => void;
}

export const TerminalPanel: React.FC<TerminalPanelProps> = observer(
  ({
    store,
    panelId,
    tabs,
    activeTabId,
    onSelectTab,
    onRequestCloseTabs,
    onLayoutHeaderContextMenu,
  }) => {
    const [menuOpen, setMenuOpen] = React.useState(false);
    const rootRef = React.useRef<HTMLDivElement | null>(null);
    const menuButtonRef = React.useRef<HTMLButtonElement | null>(null);
    const menuRef = React.useRef<HTMLDivElement | null>(null);
    const [menuStyle, setMenuStyle] = React.useState<
      React.CSSProperties | undefined
    >(undefined);
    const t = store.i18n.t;
    const isLayoutDragSource =
      store.layout.isDragging && store.layout.draggingPanelId === panelId;
    const panelRect = store.layout.getPanelRect(panelId);
    const layoutSignature = `${Math.round(panelRect?.width || 0)}x${Math.round(panelRect?.height || 0)}`;
    const tabBarMode = resolvePanelTabBarMode(
      "terminal",
      panelRect?.width || 0,
      tabs.length,
      store.panelTabDisplayMode,
    );
    const activeTab =
      tabs.find((tab) => tab.id === activeTabId) || tabs[0] || null;
    const activeIconKind = activeTab
      ? getTerminalConnectionIconKind(activeTab.config.type)
      : "generic";
    const ActiveIcon = resolveTerminalTabIcon(activeIconKind);
    const activeRuntimeIndicatorState = activeTab
      ? resolveTerminalRuntimeIndicatorState(
          activeTab.config.type,
          activeTab.runtimeState || "initializing",
        )
      : "inactive";
    const menuPlatformClassName = React.useMemo(() => {
      if (isWindows()) return "is-platform-windows";
      if (isLinux()) return "is-platform-linux";
      return "";
    }, []);

    const recomputeMenuPosition = React.useCallback(() => {
      const trigger = menuButtonRef.current;
      const menu = menuRef.current;
      if (!trigger || !menu) return;

      const rect = trigger.getBoundingClientRect();
      const measured = menu.getBoundingClientRect();
      const placement = resolveFloatingMenuPlacement({
        anchorRect: {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        },
        menuWidth: Math.ceil(measured.width),
        menuHeight: Math.ceil(measured.height),
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        margin: 8,
        gap: 4,
        preferredMaxHeight: 300,
      });

      setMenuStyle({
        position: "fixed",
        top: placement.top,
        left: placement.left,
        maxHeight: placement.maxHeight,
        maxWidth: placement.maxWidth,
      });
    }, []);

    React.useEffect(() => {
      if (!menuOpen) return;

      const onMouseDown = (event: MouseEvent) => {
        const target = event.target as Node | null;
        if (!target) return;
        if (menuRef.current?.contains(target)) return;
        if (
          rootRef.current?.contains(target) &&
          (target as HTMLElement).closest(".tab-add-btn")
        )
          return;
        setMenuOpen(false);
      };

      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") setMenuOpen(false);
      };

      const onReflow = () => {
        recomputeMenuPosition();
      };

      window.addEventListener("mousedown", onMouseDown);
      window.addEventListener("keydown", onKeyDown);
      window.addEventListener("resize", onReflow);
      window.addEventListener("scroll", onReflow, true);
      return () => {
        window.removeEventListener("mousedown", onMouseDown);
        window.removeEventListener("keydown", onKeyDown);
        window.removeEventListener("resize", onReflow);
        window.removeEventListener("scroll", onReflow, true);
      };
    }, [menuOpen, recomputeMenuPosition]);

    React.useLayoutEffect(() => {
      if (!menuOpen) return;
      recomputeMenuPosition();
    }, [menuOpen, recomputeMenuPosition]);

    return (
      <div
        className={`panel panel-terminal${isLayoutDragSource ? " is-dragging-source" : ""}`}
        ref={rootRef}
      >
        <div
          className="terminal-tabs-container is-draggable"
          draggable
          data-layout-panel-draggable="true"
          data-layout-panel-id={panelId}
          data-layout-panel-kind="terminal"
          onContextMenu={onLayoutHeaderContextMenu}
        >
          <div className="panel-tab-drag-handle" aria-hidden="true">
            <GripVertical size={12} strokeWidth={2.4} />
          </div>
          {tabBarMode === "select" ? (
            <CompactPanelTabSelect
              className="terminal-tabs-select"
              panelId={panelId}
              panelKind="terminal"
              value={activeTab?.id || null}
              options={tabs.map((tab) => {
                const iconKind = getTerminalConnectionIconKind(tab.config.type);
                const Icon = resolveTerminalTabIcon(iconKind);
                const runtimeIndicatorState =
                  resolveTerminalRuntimeIndicatorState(
                    tab.config.type,
                    tab.runtimeState || "initializing",
                  );
                return {
                  value: tab.id,
                  label: tab.title,
                  measureKey: tab.title,
                  leading: (
                    <span className="tab-icon">
                      <Icon size={14} strokeWidth={2} />
                    </span>
                  ),
                  leadingMeasureKey: iconKind,
                  trailing: (
                    <span
                      className={`tab-runtime-state tab-runtime-state-${runtimeIndicatorState}`}
                      title={tab.runtimeState || "initializing"}
                    />
                  ),
                  trailingMeasureKey: runtimeIndicatorState,
                  onClose: () => {
                    if (onRequestCloseTabs) {
                      onRequestCloseTabs([tab.id]);
                      return;
                    }
                    void store.closeTab(tab.id);
                  },
                  closeTitle: t.common.close,
                };
              })}
              onChange={onSelectTab}
              leading={
                activeTab ? (
                  <span className="tab-icon">
                    <ActiveIcon size={14} strokeWidth={2} />
                  </span>
                ) : null
              }
              leadingMeasureKey={activeIconKind}
              trailing={
                activeTab ? (
                  <span
                    className={`tab-runtime-state tab-runtime-state-${activeRuntimeIndicatorState}`}
                    title={activeTab.runtimeState || "initializing"}
                  />
                ) : null
              }
              trailingMeasureKey={activeRuntimeIndicatorState}
              actions={
                activeTab ? (
                  <button
                    className="gyshell-compact-tab-select-action"
                    title={t.common.close}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (onRequestCloseTabs) {
                        onRequestCloseTabs([activeTab.id]);
                        return;
                      }
                      void store.closeTab(activeTab.id);
                    }}
                  >
                    <X size={14} strokeWidth={2} />
                  </button>
                ) : null
              }
            />
          ) : (
            <div
              className="terminal-tabs-bar"
              data-layout-tab-bar="true"
              data-layout-tab-panel-id={panelId}
              data-layout-tab-kind="terminal"
            >
              {tabs.map((tab, index) => {
                const isActive = tab.id === activeTabId;
                const runtimeState = tab.runtimeState || "initializing";
                const iconKind = getTerminalConnectionIconKind(tab.config.type);
                const Icon = resolveTerminalTabIcon(iconKind);
                const runtimeIndicatorState =
                  resolveTerminalRuntimeIndicatorState(
                    tab.config.type,
                    runtimeState,
                  );

                return (
                  <div
                    key={tab.id}
                    className={isActive ? "tab is-active" : "tab"}
                    onClick={() => onSelectTab(tab.id)}
                    role="button"
                    tabIndex={0}
                    draggable
                    data-layout-tab-draggable="true"
                    data-layout-tab-id={tab.id}
                    data-layout-tab-kind="terminal"
                    data-layout-tab-panel-id={panelId}
                    data-layout-tab-index={index}
                  >
                    <span className="tab-icon">
                      <Icon size={14} strokeWidth={2} />
                    </span>
                    <span className="tab-title">{tab.title}</span>
                    <span
                      className={`tab-runtime-state tab-runtime-state-${runtimeIndicatorState}`}
                      title={runtimeState}
                    />
                    <button
                      className="tab-close"
                      title={t.common.close}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (onRequestCloseTabs) {
                          onRequestCloseTabs([tab.id]);
                          return;
                        }
                        void store.closeTab(tab.id);
                      }}
                    >
                      <X size={14} strokeWidth={2} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          <div className="terminal-tabs-actions">
            <button
              ref={menuButtonRef}
              className="icon-btn-sm tab-add-btn"
              title={t.terminal.newTab}
              onClick={() => setMenuOpen((v) => !v)}
            >
              <Plus size={14} strokeWidth={2} />
            </button>
          </div>
          {menuOpen
            ? createPortal(
                <div
                  className={
                    menuPlatformClassName
                      ? `win-select-menu tab-menu ${menuPlatformClassName}`
                      : "win-select-menu tab-menu"
                  }
                  role="menu"
                  ref={menuRef}
                  style={menuStyle}
                >
                  <button
                    className="tab-menu-item"
                    onClick={() => {
                      store.createLocalTab(panelId);
                      setMenuOpen(false);
                    }}
                  >
                    <Laptop size={14} strokeWidth={2} />
                    <span>{t.terminal.local}</span>
                  </button>

                  {store.settings?.connections?.ssh?.length ? (
                    <div className="tab-menu-sep" />
                  ) : null}

                  {store.settings?.connections?.ssh?.map((entry) => (
                    <button
                      key={entry.id}
                      className="tab-menu-item"
                      onClick={() => {
                        store.createSshTab(entry.id, panelId);
                        setMenuOpen(false);
                      }}
                    >
                      <Server size={14} strokeWidth={2} />
                      <span>
                        {entry.name || `${entry.username}@${entry.host}`}
                      </span>
                    </button>
                  ))}

                  <div className="tab-menu-sep" />
                  <button
                    className="tab-menu-item"
                    onClick={() => {
                      store.openConnections();
                      setMenuOpen(false);
                    }}
                  >
                    <Server size={14} strokeWidth={2} />
                    <span>{t.connections.manage}</span>
                  </button>
                </div>,
                document.body,
              )
            : null}
        </div>

        <div className="panel-body">
          {tabs.length ? (
            <div className="terminal-stack">
              {tabs.map((tab) => {
                const isActive = tab.id === activeTabId;
                return (
                  <div
                    key={tab.id}
                    className={
                      isActive ? "terminal-layer is-active" : "terminal-layer"
                    }
                  >
                    <XTermView
                      config={tab.config}
                      theme={store.xtermTheme}
                      terminalSettings={store.settings?.terminal}
                      remoteOs={tab.remoteOs}
                      systemInfo={tab.systemInfo}
                      isOwnedByUi={() =>
                        store.terminalTabs.some(
                          (candidate) => candidate.id === tab.id,
                        )
                      }
                      isActive={isActive}
                      layoutSignature={layoutSignature}
                      onSelectionChange={(text) =>
                        store.setTerminalSelection(tab.id, text)
                      }
                    />
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="placeholder">No Terminal</div>
          )}
        </div>
      </div>
    );
  },
);
