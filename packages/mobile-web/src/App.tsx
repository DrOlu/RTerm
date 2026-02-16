import React from 'react'
import type { AgentTimelineItem } from './lib/chat-timeline'
import { MessageList } from './components/chat/MessageList'
import { MessageDetailSheet } from './components/chat/MessageDetailSheet'
import { SessionBrowser, type SessionBrowserItem } from './components/chat/SessionBrowser'
import { ComposerBar } from './components/composer/ComposerBar'
import { BottomNav, type MobileTabKey } from './components/layout/BottomNav'
import { TopBar } from './components/layout/TopBar'
import { SettingsPanel } from './components/panels/SettingsPanel'
import { SkillsPanel } from './components/panels/SkillsPanel'
import { TerminalPanel } from './components/panels/TerminalPanel'
import { ToolsPanel } from './components/panels/ToolsPanel'
import { useMobileController } from './hooks/useMobileController'
import { formatSessionListTitle, formatTopBarSessionTitle } from './lib/session-title'

type ChatSubView = 'sessions' | 'conversation'

export const App: React.FC = () => {
  const { state, actions } = useMobileController()
  const [activeTab, setActiveTab] = React.useState<MobileTabKey>('chat')
  const [chatSubView, setChatSubView] = React.useState<ChatSubView>('sessions')
  const [sessionSearchQuery, setSessionSearchQuery] = React.useState('')
  const [detailTurnId, setDetailTurnId] = React.useState<string | null>(null)

  const messageListRef = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    if (activeTab !== 'chat' || chatSubView !== 'conversation') return
    const element = messageListRef.current
    if (!element) return
    element.scrollTop = element.scrollHeight
  }, [activeTab, chatSubView, state.activeSessionId, state.chatTimeline])

  React.useEffect(() => {
    setDetailTurnId(null)
  }, [state.activeSessionId])

  const sessionItems = React.useMemo<SessionBrowserItem[]>(() => {
    return state.sessionOrder.map((sessionId) => {
      const meta = state.sessionMeta[sessionId]
      const session = state.sessions[sessionId]
      return {
        id: sessionId,
        title: formatSessionListTitle(meta?.title || session?.title || 'Untitled'),
        updatedAt: meta?.updatedAt || Date.now(),
        preview: meta?.lastMessagePreview || '',
        messagesCount: meta?.messagesCount || 0,
        isRunning: !!(session?.isBusy || session?.isThinking)
      }
    })
  }, [state.sessionMeta, state.sessionOrder, state.sessions])
  const filteredSessionItems = React.useMemo(() => {
    const keyword = sessionSearchQuery.trim().toLowerCase()
    if (!keyword) return sessionItems
    return sessionItems.filter((item) => {
      const haystack = `${item.title}\n${item.preview}`.toLowerCase()
      return haystack.includes(keyword)
    })
  }, [sessionItems, sessionSearchQuery])

  const topBarSessionTitle = formatTopBarSessionTitle(state.activeSession?.title || 'No Session')
  const sessionShortId = state.activeSessionId ? state.activeSessionId.slice(0, 8) : undefined
  const canSend = state.connectionStatus === 'connected' && state.composerValue.trim().length > 0
  const activeSessionLockedProfileId = state.activeSession?.lockedProfileId || null
  const activeDetailTurn = React.useMemo<AgentTimelineItem | null>(() => {
    if (!detailTurnId) return null
    const turn = state.chatTimeline.find((item) => item.kind === 'agent' && item.id === detailTurnId)
    return turn && turn.kind === 'agent' ? turn : null
  }, [detailTurnId, state.chatTimeline])
  const detailOpen = activeTab === 'chat' && chatSubView === 'conversation' && !!activeDetailTurn

  const topTitle =
    activeTab === 'chat'
      ? chatSubView === 'sessions'
        ? 'Chats'
        : topBarSessionTitle
      : activeTab === 'terminal'
        ? 'Terminal'
        : activeTab === 'skills'
          ? 'Skills'
          : activeTab === 'tools'
            ? 'Tools'
          : 'Settings'

  return (
    <div className="mobile-app-shell">
      <div className="mobile-app modern">
        <TopBar
          title={topTitle}
          sessionId={activeTab === 'chat' && chatSubView === 'conversation' ? sessionShortId : undefined}
          connectionStatus={state.connectionStatus}
          onOpenSessions={() => {
            setChatSubView('sessions')
          }}
          onBack={
            activeTab === 'chat' && chatSubView === 'conversation'
              ? () => setChatSubView('sessions')
              : undefined
          }
          showSessionMeta={activeTab === 'chat' && chatSubView === 'conversation'}
          showSessionAction={false}
        />

        {state.connectionError ? <section className="error-strip-modern">{state.connectionError}</section> : null}

        {activeTab === 'chat' ? (
          chatSubView === 'sessions' ? (
            <SessionBrowser
              activeSessionId={state.activeSessionId}
              items={filteredSessionItems}
              searchQuery={sessionSearchQuery}
              onSearchChange={setSessionSearchQuery}
              onCreateSession={async () => {
                await actions.createSession()
                setSessionSearchQuery('')
                setChatSubView('conversation')
              }}
              onOpenSession={async (sessionId) => {
                await actions.switchSession(sessionId)
                setChatSubView('conversation')
              }}
            />
          ) : (
            <>
              <MessageList
                items={state.chatTimeline}
                onAskDecision={actions.replyAsk}
                onOpenDetail={setDetailTurnId}
                listRef={messageListRef}
              />

              <ComposerBar
                value={state.composerValue}
                cursor={state.composerCursor}
                onChange={actions.setComposerValue}
                onCursorChange={actions.setComposerCursor}
                onSend={() => void actions.sendMessage()}
                onStop={() => void actions.stopActiveSession()}
                canSend={canSend}
                isRunning={state.isRunning}
                profiles={state.profiles}
                activeProfileId={state.activeProfileId}
                lockedProfileId={activeSessionLockedProfileId}
                tokenUsagePercent={state.tokenUsagePercent}
                onUpdateProfile={(profileId) => void actions.updateProfile(profileId)}
                mentionOptions={state.mentionOptions}
                onPickMention={actions.pickMention}
              />
            </>
          )
        ) : null}

        {activeTab === 'terminal' ? (
          <TerminalPanel
            terminals={state.terminals}
            onCreateTerminal={() => void actions.createTerminalTab()}
            onCloseTerminal={(terminalId) => void actions.closeTerminalTab(terminalId)}
          />
        ) : null}

        {activeTab === 'skills' ? (
          <SkillsPanel
            skills={state.skills}
            connectionStatus={state.connectionStatus}
            onReload={actions.reloadSkills}
            onSetSkillEnabled={actions.setSkillEnabled}
          />
        ) : null}

        {activeTab === 'settings' ? (
          <SettingsPanel
            gatewayInput={state.gatewayInput}
            connectionStatus={state.connectionStatus}
            actionPending={state.actionPending}
            connectionError={state.connectionError}
            onGatewayInputChange={actions.setGatewayInput}
            onConnect={() => void actions.connectGateway()}
            onDisconnect={actions.disconnectGateway}
          />
        ) : null}

        {activeTab === 'tools' ? (
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
            if (nextTab === 'chat' && activeTab === 'chat') {
              setChatSubView('sessions')
            }
            setActiveTab(nextTab)
          }}
        />

        <MessageDetailSheet
          open={detailOpen}
          turn={activeDetailTurn}
          onClose={() => setDetailTurnId(null)}
          onAskDecision={actions.replyAsk}
        />
      </div>
    </div>
  )
}
