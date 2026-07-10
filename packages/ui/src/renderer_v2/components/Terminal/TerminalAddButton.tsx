import React from "react";
import { createPortal } from "react-dom";
import { Laptop, Plus, Server } from "lucide-react";
import type { AppStore } from "../../stores/AppStore";
import { resolveFloatingMenuPlacement } from "../../lib/menuPlacement";
import { isLinux, isWindows } from "../../platform/platform";

export interface TerminalAddButtonCreateContext {
  type: "local" | "ssh";
}

interface TerminalAddButtonProps {
  store: AppStore;
  targetPanelId?: string | null;
  className?: string;
  title: string;
  ariaLabel?: string;
  open?: boolean;
  ensurePanelOnCreate?: boolean;
  onOpenChange?: (open: boolean) => void;
  onTabCreated?: (
    tabId: string,
    context: TerminalAddButtonCreateContext,
  ) => void;
  createSshInBackground?: boolean;
}

export const TerminalAddButton: React.FC<TerminalAddButtonProps> = ({
  store,
  targetPanelId,
  className = "tab-add-btn",
  title,
  ariaLabel,
  open,
  ensurePanelOnCreate = true,
  onOpenChange,
  onTabCreated,
  createSshInBackground = false,
}) => {
  const [internalOpen, setInternalOpen] = React.useState(false);
  const isOpen = open ?? internalOpen;
  const buttonRef = React.useRef<HTMLButtonElement | null>(null);
  const menuRef = React.useRef<HTMLDivElement | null>(null);
  const [menuStyle, setMenuStyle] = React.useState<
    React.CSSProperties | undefined
  >(undefined);
  const t = store.i18n.t;
  const menuPlatformClassName = React.useMemo(() => {
    if (isWindows()) return "is-platform-windows";
    if (isLinux()) return "is-platform-linux";
    return "";
  }, []);

  const setOpen = React.useCallback(
    (nextOpen: boolean) => {
      if (open === undefined) {
        setInternalOpen(nextOpen);
      }
      onOpenChange?.(nextOpen);
    },
    [onOpenChange, open],
  );

  const resolvedTargetPanelId = targetPanelId || undefined;

  const recomputeMenuPosition = React.useCallback(() => {
    const trigger = buttonRef.current;
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
    if (!isOpen) return;

    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (menuRef.current?.contains(target)) return;
      if (buttonRef.current?.contains(target)) return;
      setOpen(false);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
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
  }, [isOpen, recomputeMenuPosition, setOpen]);

  React.useLayoutEffect(() => {
    if (!isOpen) return;
    recomputeMenuPosition();
  }, [isOpen, recomputeMenuPosition]);

  const menuClassName = menuPlatformClassName
    ? `win-select-menu tab-menu ${menuPlatformClassName}`
    : "win-select-menu tab-menu";

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={className}
        title={title}
        aria-label={ariaLabel || title}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={() => setOpen(!isOpen)}
      >
        <Plus size={14} strokeWidth={2} />
      </button>
      {isOpen
        ? createPortal(
            <div
              className={menuClassName}
              role="menu"
              ref={menuRef}
              style={menuStyle}
            >
              <button
                className="tab-menu-item"
                onClick={() => {
                  const shouldStartLocalRuntime =
                    ensurePanelOnCreate === false && !resolvedTargetPanelId;
                  const tabId = store.createLocalTab(resolvedTargetPanelId, {
                    ensurePanel: ensurePanelOnCreate,
                    startRuntime: shouldStartLocalRuntime,
                  });
                  onTabCreated?.(tabId, { type: "local" });
                  setOpen(false);
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
                    const sshTargetPanelId = createSshInBackground
                      ? undefined
                      : resolvedTargetPanelId;
                    const tabId = store.createSshTab(
                      entry.id,
                      sshTargetPanelId,
                      createSshInBackground
                        ? {
                            ensurePanel: false,
                            attachToPanel: false,
                            startRuntime: true,
                          }
                        : {
                            ensurePanel: ensurePanelOnCreate,
                          },
                    );
                    if (tabId) {
                      onTabCreated?.(tabId, { type: "ssh" });
                    }
                    setOpen(false);
                  }}
                >
                  <Server size={14} strokeWidth={2} />
                  <span>{entry.name || `${entry.username}@${entry.host}`}</span>
                </button>
              ))}

              <div className="tab-menu-sep" />
              <button
                className="tab-menu-item"
                onClick={() => {
                  store.openConnections();
                  setOpen(false);
                }}
              >
                <Server size={14} strokeWidth={2} />
                <span>{t.connections.manage}</span>
              </button>
            </div>,
            document.body,
          )
        : null}
    </>
  );
};
