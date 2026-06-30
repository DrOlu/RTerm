import React from "react";
import { AlertTriangle, Plus, Search, MessageSquare, Trash2 } from "lucide-react";
import { formatRelativeTime } from "../../format";
import { useMobileI18n } from "../../i18n/provider";
import type {
  SessionStatusDetail,
  SessionStatusInfo,
} from "../../hooks/mobileControllerHelpers";
import type { MobileTranslations } from "../../i18n/types";

const DELETE_REVEAL_PX = 82;
const SWIPE_OPEN_THRESHOLD_PX = DELETE_REVEAL_PX * 0.5;
const SWIPE_DIRECTION_BUFFER_PX = 8;

/**
 * Pure decision helpers for the swipe-to-delete gesture.
 *
 * Extracted as named exports so the gesture state machine can be unit-tested
 * without rendering React. The rules are intentionally conservative:
 * - Horizontal intent is only locked in once the X delta clearly dominates,
 *   so a vertical scroll never accidentally reveals the delete rail.
 * - The reveal threshold is half the rail width, matching iOS Mail / WeChat
 *   conventions users already know.
 * - If the gesture started on a horizontal axis, we always consume the next
 *   tap so the click handler does not also open the session (which would
 *   feel like a double-action bug).
 */
export function resolveSwipeAxis(
  deltaX: number,
  deltaY: number,
  currentAxis: "pending" | "horizontal" | "vertical",
): "pending" | "horizontal" | "vertical" {
  if (currentAxis !== "pending") return currentAxis;
  if (
    Math.abs(deltaX) < SWIPE_DIRECTION_BUFFER_PX &&
    Math.abs(deltaY) < SWIPE_DIRECTION_BUFFER_PX
  ) {
    return "pending";
  }
  return Math.abs(deltaX) > Math.abs(deltaY) ? "horizontal" : "vertical";
}

export function clampSwipeOffset(
  baseOffset: number,
  deltaX: number,
): number {
  return Math.max(-DELETE_REVEAL_PX, Math.min(0, baseOffset + deltaX));
}

export function shouldRevealDeleteRail(offset: number): boolean {
  // Only a leftward (negative) drag past the threshold reveals the rail.
  // A positive offset is impossible in practice (clampSwipeOffset blocks it),
  // but we guard defensively so a future change can't accidentally reveal.
  if (offset >= 0) return false;
  return Math.abs(offset) >= SWIPE_OPEN_THRESHOLD_PX;
}

export const SWIPE_CONSTANTS = {
  DELETE_REVEAL_PX,
  SWIPE_OPEN_THRESHOLD_PX,
  SWIPE_DIRECTION_BUFFER_PX,
} as const;

export interface SessionBrowserItem {
  id: string;
  title: string;
  updatedAt: number;
  preview: string;
  messagesCount: number;
  isRunning: boolean;
  status: SessionStatusInfo;
  tokenUsagePercent: number | null;
}

interface SessionBrowserProps {
  activeSessionId: string | null;
  items: SessionBrowserItem[];
  searchQuery: string;
  onSearchChange: (value: string) => void;
  onCreateSession: () => void;
  onOpenSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  pendingApprovalCount: number;
  onJumpToApproval: () => void;
}

function statusDotClass(status: SessionStatusInfo): string {
  switch (status.kind) {
    case "approval":
      return "approval";
    case "error":
      return "error";
    case "thinking":
    case "tool":
    case "running":
      return "running";
    case "done":
    default:
      return "idle";
  }
}

/**
 * Resolve a locale-free SessionStatusInfo into a localized label.
 *
 * The helper layer (mobileControllerHelpers) deliberately returns only a
 * structural descriptor (kind + detail + optional contextName) so it stays
 * free of any language dependency. This function is the single i18n seam that
 * maps that descriptor to the user-facing string, keeping all translation
 * concerns in the presentation layer.
 */
export function resolveStatusLabel(
  status: SessionStatusInfo,
  t: MobileTranslations,
): string {
  const ctx = status.contextName;
  switch (status.detail as SessionStatusDetail) {
    case "approval":
      return ctx ? t.sessionBrowser.statusApprovalWithTool(ctx) : t.sessionBrowser.statusApproval;
    case "error":
      return t.sessionBrowser.statusError;
    case "thinking":
      return t.sessionBrowser.statusThinking;
    case "replying":
      return t.sessionBrowser.statusReplying;
    case "tool":
      return ctx ? t.sessionBrowser.statusToolWithName(ctx) : t.sessionBrowser.statusTool;
    case "file_edit":
      return t.sessionBrowser.statusFileEdit;
    case "sub_tool":
      return t.sessionBrowser.statusSubTool;
    case "command":
      return t.sessionBrowser.statusCommand;
    case "command_async":
      return t.sessionBrowser.statusCommandAsync;
    case "compacting":
      return t.sessionBrowser.statusCompacting;
    case "running":
      return t.sessionBrowser.statusRunning;
    case "done":
    default:
      return t.sessionBrowser.statusDone;
  }
}

export const SessionBrowser: React.FC<SessionBrowserProps> = ({
  activeSessionId,
  items,
  searchQuery,
  onSearchChange,
  onCreateSession,
  onOpenSession,
  onDeleteSession,
  pendingApprovalCount,
  onJumpToApproval,
}) => {
  const { t } = useMobileI18n();
  const [openDeleteId, setOpenDeleteId] = React.useState<string | null>(null);
  const [dragState, setDragState] = React.useState<{
    sessionId: string;
    offset: number;
  } | null>(null);
  const touchDragRef = React.useRef<{
    sessionId: string;
    x: number;
    y: number;
    axis: "pending" | "horizontal" | "vertical";
    baseOffset: number;
    offset: number;
  } | null>(null);
  const suppressNextOpenRef = React.useRef(false);

  React.useEffect(() => {
    if (!openDeleteId) return;
    if (!items.some((item) => item.id === openDeleteId)) {
      setOpenDeleteId(null);
    }
  }, [items, openDeleteId]);

  const handleTouchStart = React.useCallback(
    (sessionId: string, event: React.TouchEvent<HTMLButtonElement>) => {
      const touch = event.touches[0];
      if (!touch) return;
      const baseOffset = openDeleteId === sessionId ? -DELETE_REVEAL_PX : 0;
      if (openDeleteId && openDeleteId !== sessionId) {
        setOpenDeleteId(null);
      }
      touchDragRef.current = {
        sessionId,
        x: touch.clientX,
        y: touch.clientY,
        axis: "pending",
        baseOffset,
        offset: baseOffset,
      };
      setDragState({ sessionId, offset: baseOffset });
    },
    [openDeleteId],
  );

  const handleTouchMove = React.useCallback(
    (sessionId: string, event: React.TouchEvent<HTMLButtonElement>) => {
      const drag = touchDragRef.current;
      if (!drag || drag.sessionId !== sessionId) return;
      const touch = event.touches[0];
      if (!touch) return;

      const deltaX = touch.clientX - drag.x;
      const deltaY = touch.clientY - drag.y;
      drag.axis = resolveSwipeAxis(deltaX, deltaY, drag.axis);

      if (drag.axis !== "horizontal") return;
      const nextOffset = clampSwipeOffset(drag.baseOffset, deltaX);
      drag.offset = nextOffset;
      setDragState({ sessionId, offset: nextOffset });
      event.preventDefault();
    },
    [],
  );

  const handleTouchEnd = React.useCallback(
    (sessionId: string) => {
      const drag = touchDragRef.current;
      touchDragRef.current = null;
      setDragState(null);
      if (!drag || drag.sessionId !== sessionId) return;

      if (drag.axis === "horizontal") {
        suppressNextOpenRef.current = true;
        const shouldOpen = shouldRevealDeleteRail(drag.offset);
        setOpenDeleteId(shouldOpen ? sessionId : null);
      }
    },
    [],
  );

  const handleTouchCancel = React.useCallback(() => {
    touchDragRef.current = null;
    setDragState(null);
  }, []);

  const handleOpenSession = React.useCallback(
    (sessionId: string) => {
      if (suppressNextOpenRef.current) {
        suppressNextOpenRef.current = false;
        return;
      }
      if (openDeleteId && openDeleteId !== sessionId) {
        setOpenDeleteId(null);
        return;
      }
      if (openDeleteId === sessionId) {
        setOpenDeleteId(null);
        return;
      }
      onOpenSession(sessionId);
    },
    [onOpenSession, openDeleteId],
  );

  const handleDeleteSession = React.useCallback(
    (sessionId: string) => {
      onDeleteSession(sessionId);
    },
    [onDeleteSession],
  );

  const handleDeleteRailPointerUp = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>, sessionId: string) => {
      event.preventDefault();
      event.stopPropagation();
      handleDeleteSession(sessionId);
    },
    [handleDeleteSession],
  );

  return (
    <section className="session-browser">
      {pendingApprovalCount > 0 ? (
        <button
          type="button"
          className="approval-badge-strip"
          onClick={onJumpToApproval}
        >
          <AlertTriangle size={14} />
          <span>{t.sessionBrowser.approvalBadge(pendingApprovalCount)}</span>
          <span className="approval-badge-tail">{t.sessionBrowser.approvalJump}</span>
        </button>
      ) : null}

      <div className="session-browser-top">
        <label className="session-search">
          <Search size={14} />
          <input
            value={searchQuery}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder={t.sessionBrowser.searchPlaceholder}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </label>
        <button
          type="button"
          className="session-create-btn"
          aria-label={t.sessionBrowser.createChat}
          title={t.sessionBrowser.createChat}
          onClick={onCreateSession}
        >
          <Plus size={15} />
        </button>
      </div>

      {items.length === 0 ? (
        <div className="empty-state panel-empty-state">
          <p className="empty-state-title">{t.sessionBrowser.empty}</p>
          <p className="empty-state-hint">{t.sessionBrowser.emptyHint}</p>
        </div>
      ) : (
        <div className="session-browser-list">
          {items.map((item) => {
            const isActive = item.id === activeSessionId;
            const isDragging = dragState?.sessionId === item.id;
            const offset =
              dragState?.sessionId === item.id
                ? dragState.offset
                : openDeleteId === item.id
                  ? -DELETE_REVEAL_PX
                  : 0;
            const isDeleteVisible = offset < -0.5;
            const deleteLabel = t.sessionBrowser.deleteChat(item.title);
            const dotClass = statusDotClass(item.status);
            const statusLabel = resolveStatusLabel(item.status, t);
            const showStatusLabel = item.status.kind !== "done";
            const tokenPercent = item.tokenUsagePercent;
            return (
              <article
                key={item.id}
                className={`session-chat-item status-${dotClass} ${isActive ? "active" : ""} ${isDeleteVisible ? "delete-visible" : ""}`}
              >
                <button
                  type="button"
                  className="session-chat-delete-rail"
                  onPointerDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  onPointerUp={(event) =>
                    handleDeleteRailPointerUp(event, item.id)
                  }
                  onClick={(event) => {
                    if (event.detail !== 0) return;
                    event.preventDefault();
                    event.stopPropagation();
                    handleDeleteSession(item.id);
                  }}
                  aria-label={deleteLabel}
                  title={deleteLabel}
                >
                  <Trash2 size={18} />
                </button>
                <button
                  type="button"
                  className={`session-chat-open ${isDragging ? "dragging" : ""}`}
                  style={{ transform: `translateX(${offset}px)` }}
                  onClick={() => handleOpenSession(item.id)}
                  onTouchStart={(event) => handleTouchStart(item.id, event)}
                  onTouchMove={(event) => handleTouchMove(item.id, event)}
                  onTouchEnd={() => handleTouchEnd(item.id)}
                  onTouchCancel={handleTouchCancel}
                  aria-label={item.title}
                >
                  <div className="session-chat-icon">
                    <MessageSquare size={18} />
                    <div
                      className={`session-status-indicator ${dotClass}`}
                    />
                  </div>
                  <div className="session-chat-main">
                    <div className="session-chat-head">
                      <h3 className="session-chat-title">{item.title}</h3>
                      <span className="session-chat-time">
                        {formatRelativeTime(item.updatedAt, t.format)}
                      </span>
                    </div>
                    {showStatusLabel ? (
                      <p
                        className={`session-chat-status status-text-${item.status.kind}`}
                      >
                        {statusLabel}
                      </p>
                    ) : null}
                    <p className="session-chat-preview">
                      {item.preview || t.sessionBrowser.noUpdates}
                    </p>
                    {tokenPercent !== null && tokenPercent >= 1 ? (
                      <div
                        className="session-token-bar"
                        role="progressbar"
                        aria-valuenow={Math.round(tokenPercent)}
                        aria-valuemin={0}
                        aria-valuemax={100}
                      >
                        <span
                          className="session-token-fill"
                          style={{ width: `${Math.min(100, tokenPercent)}%` }}
                        />
                      </div>
                    ) : null}
                  </div>
                </button>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
};
