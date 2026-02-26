import React from "react";
import type { AgentTimelineItem } from "./lib/chat-timeline";
import { MessageList } from "./components/chat/MessageList";
import { MessageDetailSheet } from "./components/chat/MessageDetailSheet";
import {
  SessionBrowser,
  type SessionBrowserItem,
} from "./components/chat/SessionBrowser";
import { ComposerBar } from "./components/composer/ComposerBar";
import { BottomNav, type MobileTabKey } from "./components/layout/BottomNav";
import { TopBar } from "./components/layout/TopBar";
import { SettingsPanel } from "./components/panels/SettingsPanel";
import { SkillsPanel } from "./components/panels/SkillsPanel";
import { TerminalPanel } from "./components/panels/TerminalPanel";
import { ToolsPanel } from "./components/panels/ToolsPanel";
import { useMobileController } from "./hooks/useMobileController";
import { useMobileI18n } from "./i18n/provider";
import {
  formatSessionListTitle,
  formatTopBarSessionTitle,
} from "./lib/session-title";
import type { ChatMessage } from "./types";

type ChatSubView = "sessions" | "conversation";
const AUTO_SCROLL_THRESHOLD_PX = 64;

function isScrolledNearBottom(
  element: HTMLElement,
  thresholdPx = AUTO_SCROLL_THRESHOLD_PX,
): boolean {
  const remainingDistance =
    element.scrollHeight - element.scrollTop - element.clientHeight;
  return remainingDistance <= thresholdPx;
}

export const App: React.FC = () => {
  const { locale, setLocale, t } = useMobileI18n();
  const { state, actions } = useMobileController();
  const [activeTab, setActiveTab] = React.useState<MobileTabKey>("chat");
  const [chatSubView, setChatSubView] = React.useState<ChatSubView>("sessions");
  const [sessionSearchQuery, setSessionSearchQuery] = React.useState("");
  const [detailTurnId, setDetailTurnId] = React.useState<string | null>(null);
  const [rollbackTarget, setRollbackTarget] =
    React.useState<ChatMessage | null>(null);
  const [rollbackPending, setRollbackPending] = React.useState(false);

  const messageListRef = React.useRef<HTMLDivElement>(null);
  const shouldStickMessageListToBottomRef = React.useRef(true);
  const previousConversationContextRef = React.useRef<{
    activeTab: MobileTabKey;
    chatSubView: ChatSubView;
    activeSessionId: string | null;
  } | null>(null);

  React.useEffect(() => {
    if (activeTab !== "chat" || chatSubView !== "conversation") return;
    const element = messageListRef.current;
    if (!element) return;
    const handleScroll = () => {
      shouldStickMessageListToBottomRef.current = isScrolledNearBottom(element);
    };
    handleScroll();
    element.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      element.removeEventListener("scroll", handleScroll);
    };
  }, [activeTab, chatSubView, state.activeSessionId]);

  React.useEffect(() => {
    const currentContext = {
      activeTab,
      chatSubView,
      activeSessionId: state.activeSessionId,
    };
    if (activeTab !== "chat" || chatSubView !== "conversation") {
      previousConversationContextRef.current = currentContext;
      return;
    }

    const element = messageListRef.current;
    if (!element) {
      previousConversationContextRef.current = currentContext;
      return;
    }

    const previousContext = previousConversationContextRef.current;
    const hasContextChanged =
      !previousContext ||
      previousContext.activeTab !== currentContext.activeTab ||
      previousContext.chatSubView !== currentContext.chatSubView ||
      previousContext.activeSessionId !== currentContext.activeSessionId;

    if (hasContextChanged || shouldStickMessageListToBottomRef.current) {
      element.scrollTop = element.scrollHeight;
      shouldStickMessageListToBottomRef.current = true;
    }

    previousConversationContextRef.current = currentContext;
  }, [activeTab, chatSubView, state.activeSessionId, state.chatTimeline]);

  React.useEffect(() => {
    setDetailTurnId(null);
    setRollbackTarget(null);
  }, [state.activeSessionId]);

  const handleRollbackConfirm = React.useCallback(async () => {
    if (!rollbackTarget) return;
    const activeSessionId = state.activeSessionId;
    const backendMessageId = rollbackTarget.backendMessageId;
    if (!activeSessionId || !backendMessageId) {
      setRollbackTarget(null);
      return;
    }

    setRollbackPending(true);
    try {
      const ok = await actions.rollbackToMessage(
        activeSessionId,
        backendMessageId,
      );
      if (!ok) return;
      const rollbackContent = String(rollbackTarget.content || "");
      actions.restoreComposerDraft(
        rollbackContent,
        rollbackTarget.metadata?.inputImages || [],
      );
    } finally {
      setRollbackPending(false);
      setRollbackTarget(null);
    }
  }, [actions, rollbackTarget, state.activeSessionId]);

  const sessionItems = React.useMemo<SessionBrowserItem[]>(() => {
    return state.sessionOrder.map((sessionId) => {
      const meta = state.sessionMeta[sessionId];
      const session = state.sessions[sessionId];
      return {
        id: sessionId,
        title: formatSessionListTitle(
          meta?.title || session?.title || t.app.untitled,
        ),
        updatedAt: meta?.updatedAt || Date.now(),
        preview: meta?.lastMessagePreview || "",
        messagesCount: meta?.messagesCount || 0,
        isRunning: !!(session?.isBusy || session?.isThinking),
      };
    });
  }, [state.sessionMeta, state.sessionOrder, state.sessions]);
  const filteredSessionItems = React.useMemo(() => {
    const keyword = sessionSearchQuery.trim().toLowerCase();
    if (!keyword) return sessionItems;
    return sessionItems.filter((item) => {
      const haystack = `${item.title}\n${item.preview}`.toLowerCase();
      return haystack.includes(keyword);
    });
  }, [sessionItems, sessionSearchQuery]);

  const topBarSessionTitle = formatTopBarSessionTitle(
    state.activeSession?.title || t.app.noSession,
  );
  const sessionShortId = state.activeSessionId
    ? state.activeSessionId.slice(0, 8)
    : undefined;
  const canSend =
    state.connectionStatus === "connected" &&
    (state.composerValue.trim().length > 0 || state.composerImages.length > 0);
  const activeSessionLockedProfileId =
    state.activeSession?.lockedProfileId || null;
  const activeDetailTurn = React.useMemo<AgentTimelineItem | null>(() => {
    if (!detailTurnId) return null;
    const turn = state.chatTimeline.find(
      (item) => item.kind === "agent" && item.id === detailTurnId,
    );
    return turn && turn.kind === "agent" ? turn : null;
  }, [detailTurnId, state.chatTimeline]);
  const detailOpen =
    activeTab === "chat" &&
    chatSubView === "conversation" &&
    !!activeDetailTurn;

  const topTitle =
    activeTab === "chat"
      ? chatSubView === "sessions"
        ? t.app.chats
        : topBarSessionTitle
      : activeTab === "terminal"
        ? t.tabs.terminal
        : activeTab === "skills"
          ? t.tabs.skills
          : activeTab === "tools"
            ? t.tabs.tools
            : t.tabs.settings;

  return (
    <div className="mobile-app-shell">
      <div className="mobile-app modern">
        <TopBar
          title={topTitle}
          sessionId={
            activeTab === "chat" && chatSubView === "conversation"
              ? sessionShortId
              : undefined
          }
          connectionStatus={state.connectionStatus}
          onOpenSessions={() => {
            setChatSubView("sessions");
          }}
          onBack={
            activeTab === "chat" && chatSubView === "conversation"
              ? () => setChatSubView("sessions")
              : undefined
          }
          showSessionMeta={
            activeTab === "chat" && chatSubView === "conversation"
          }
          showSessionAction={false}
        />

        {state.connectionError ? (
          <section className="error-strip-modern">
            {state.connectionError}
          </section>
        ) : null}

        {activeTab === "chat" ? (
          chatSubView === "sessions" ? (
            <SessionBrowser
              activeSessionId={state.activeSessionId}
              items={filteredSessionItems}
              searchQuery={sessionSearchQuery}
              onSearchChange={setSessionSearchQuery}
              onCreateSession={async () => {
                await actions.createSession();
                setSessionSearchQuery("");
                setChatSubView("conversation");
              }}
              onOpenSession={async (sessionId) => {
                await actions.switchSession(sessionId);
                setChatSubView("conversation");
              }}
              onDeleteSession={async (sessionId) => {
                const target = sessionItems.find((item) => item.id === sessionId);
                const title = target?.title || t.app.untitled;
                if (!window.confirm(t.sessionBrowser.deleteConfirm(title))) {
                  return;
                }
                const deleted = await actions.deleteSession(sessionId);
                if (deleted && state.activeSessionId === sessionId) {
                  setChatSubView("sessions");
                }
              }}
            />
          ) : (
            <>
              <MessageList
                items={state.chatTimeline}
                onAskDecision={actions.replyAsk}
                onOpenDetail={setDetailTurnId}
                onRollback={setRollbackTarget}
                rollbackDisabled={state.isRunning || rollbackPending}
                listRef={messageListRef}
              />

              <ComposerBar
                value={state.composerValue}
                cursor={state.composerCursor}
                images={state.composerImages}
                onChange={actions.setComposerValue}
                onCursorChange={actions.setComposerCursor}
                onAttachImages={(files) => void actions.attachImages(files)}
                onRemoveImage={actions.removeComposerImage}
                onClearImages={actions.clearComposerImages}
                onSend={() => void actions.sendMessage()}
                onStop={() => void actions.stopActiveSession()}
                canSend={canSend}
                isRunning={state.isRunning}
                profiles={state.profiles}
                activeProfileId={state.activeProfileId}
                lockedProfileId={activeSessionLockedProfileId}
                tokenUsagePercent={state.tokenUsagePercent}
                onUpdateProfile={(profileId) =>
                  void actions.updateProfile(profileId)
                }
                mentionOptions={state.mentionOptions}
                onPickMention={actions.pickMention}
              />
            </>
          )
        ) : null}

        {activeTab === "terminal" ? (
          <TerminalPanel
            terminals={state.terminals}
            sshConnections={state.sshConnections}
            onCreateTerminal={(target) =>
              void actions.createTerminalTab(target)
            }
            onCloseTerminal={(terminalId) =>
              void actions.closeTerminalTab(terminalId)
            }
          />
        ) : null}

        {activeTab === "skills" ? (
          <SkillsPanel
            skills={state.skills}
            connectionStatus={state.connectionStatus}
            onReload={actions.reloadSkills}
            onSetSkillEnabled={actions.setSkillEnabled}
          />
        ) : null}

        {activeTab === "settings" ? (
          <SettingsPanel
            gatewayInput={state.gatewayInput}
            accessTokenInput={state.accessTokenInput}
            connectionStatus={state.connectionStatus}
            actionPending={state.actionPending}
            connectionError={state.connectionError}
            onGatewayInputChange={actions.setGatewayInput}
            onAccessTokenInputChange={actions.setAccessTokenInput}
            onConnect={() => void actions.connectGateway()}
            onDisconnect={actions.disconnectGateway}
            locale={locale}
            onLocaleChange={setLocale}
            memoryEnabled={state.memoryEnabled}
            memoryFilePath={state.memoryFilePath}
            memoryContent={state.memoryContent}
            onReloadMemory={() => void actions.reloadMemory()}
          />
        ) : null}

        {activeTab === "tools" ? (
          <ToolsPanel
            mcpTools={state.mcpTools}
            builtInTools={state.builtInTools}
            connectionStatus={state.connectionStatus}
            onReload={actions.reloadTools}
            onSetMcpEnabled={actions.setMcpEnabled}
            onSetBuiltInEnabled={actions.setBuiltInToolEnabled}
          />
        ) : null}

        <BottomNav
          activeTab={activeTab}
          onChange={(nextTab) => {
            if (nextTab === "chat" && activeTab === "chat") {
              setChatSubView("sessions");
            }
            setActiveTab(nextTab);
          }}
        />

        <MessageDetailSheet
          open={detailOpen}
          turn={activeDetailTurn}
          onClose={() => setDetailTurnId(null)}
          onAskDecision={actions.replyAsk}
        />

        {rollbackTarget ? (
          <div className="confirm-overlay" role="presentation">
            <div
              className="confirm-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="rollback-confirm-title"
            >
              <h3 id="rollback-confirm-title">{t.app.rollbackConfirmTitle}</h3>
              <p>{t.app.rollbackConfirmMessage}</p>
              <div className="confirm-dialog-actions">
                <button
                  type="button"
                  className="accent-btn-flat"
                  onClick={() => setRollbackTarget(null)}
                  disabled={rollbackPending}
                >
                  {t.common.cancel}
                </button>
                <button
                  type="button"
                  className="danger-btn-flat"
                  onClick={() => void handleRollbackConfirm()}
                  disabled={rollbackPending}
                >
                  {rollbackPending ? t.app.rollingBack : t.app.rollback}
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
};
