import React from "react";
import type { LucideIcon } from "lucide-react";
import { MessageCircle, Settings, TerminalSquare } from "lucide-react";
import { useMobileI18n } from "../../i18n/provider";

/**
 * Mobile-web v2 bottom navigation.
 *
 * Design rationale: the old 5-tab layout (chat/terminal/skills/tools/settings) was a
 * 1:1 mirror of the desktop sidebar. Mobile is a steering client, not a feature mirror:
 * - Sessions is the primary surface (monitoring + approvals + follow-ups).
 * - Terminals is the secondary surface (remote output monitoring).
 * - Settings absorbs the low-frequency config (skills/tools/agent profiles/connection).
 *
 * 3 tabs matches the iOS/Android Human Interface Guidelines sweet spot and avoids
 * mis-taps on small screens. Skills/Tools live as Settings sub-pages.
 */
export type MobileTabKey = "sessions" | "terminals" | "settings";

interface BottomNavProps {
  activeTab: MobileTabKey;
  onChange: (tab: MobileTabKey) => void;
  /** Optional badge dot shown on the Sessions tab (e.g. pending approvals). */
  sessionsBadge?: boolean;
}

const TABS: Array<{ key: MobileTabKey; icon: LucideIcon }> = [
  { key: "sessions", icon: MessageCircle },
  { key: "terminals", icon: TerminalSquare },
  { key: "settings", icon: Settings },
];

export const BottomNav: React.FC<BottomNavProps> = ({
  activeTab,
  onChange,
  sessionsBadge = false,
}) => {
  const { t } = useMobileI18n();
  const labels: Record<MobileTabKey, string> = {
    sessions: t.tabs.sessions,
    terminals: t.tabs.terminals,
    settings: t.tabs.settings,
  };

  return (
    <nav className="bottom-nav" aria-label={t.tabs.navLabel}>
      {TABS.map((tab) => {
        const Icon = tab.icon;
        const label = labels[tab.key];
        const isActive = activeTab === tab.key;
        const showBadge = tab.key === "sessions" && sessionsBadge;
        return (
          <button
            key={tab.key}
            type="button"
            className={`bottom-nav-item ${isActive ? "active" : ""}`}
            onClick={() => onChange(tab.key)}
            aria-label={label}
            title={label}
          >
            <span className="bottom-nav-icon-wrap">
              <Icon size={18} />
              {showBadge ? (
                <span
                  className="bottom-nav-badge"
                  aria-hidden="true"
                />
              ) : null}
            </span>
            <span className="bottom-nav-label">{label}</span>
          </button>
        );
      })}
    </nav>
  );
};
