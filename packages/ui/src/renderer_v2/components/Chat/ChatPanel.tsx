import React, { useEffect, useRef, useState, useLayoutEffect, useCallback } from 'react'
import { Square, Plus, X, History, CornerDownLeft, Play, MoreVertical, GripVertical } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import type { AppStore } from '../../stores/AppStore'
import type { ChatMessage } from '../../stores/ChatStore'
import { ChatHistoryPanel } from './ChatHistoryPanel'
import { MessageRow } from './MessageRow'
import { ConfirmDialog } from '../Common/ConfirmDialog'
import { Select } from '../../platform/Select'
import type { SelectHandle } from '../../platform/windows/WindowsSelect'
import { QueueManager } from './Queue/QueueManager'
import { QueueModeSwitch } from './Queue/QueueModeSwitch'
import type { QueueItem } from '../../stores/ChatQueueStore'
import { RichInput, type RichInputHandle } from './RichInput'
import { CHAT_PANEL_SESSION_TITLE_CHAR_LIMIT, formatChatPanelSessionTitle } from '../../lib/sessionTitleDisplay'
import type { ComposerDraft, InputImageAttachment } from '../../lib/userInput'
import './chat.scss'

import { createPortal } from 'react-dom'

const TokenTooltip: React.FC<{ 
  mouseX: number;
  mouseY: number;
  content: string; 
}> = ({ mouseX, mouseY, content }) => {
  const tooltipRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const el = tooltipRef.current
    if (!el) return

    // 1. Get actual dimensions of the element
    const measured = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const margin = 24 // Keep 24px distance from the window edge
    const gap = 12   // 12px distance from the mouse cursor

    let x = mouseX
    let y = mouseY - gap

    // 2. Horizontal boundary avoidance
    const halfWidth = measured.width / 2
    if (x - halfWidth < margin) {
      x = margin + halfWidth
    } else if (x + halfWidth > vw - margin) {
      x = vw - margin - halfWidth
    }

    // 3. Vertical boundary avoidance and flipping
    let verticalTranslate = '-100%' // Default above the mouse
    if (y - measured.height < margin) {
      y = mouseY + gap // Insufficient space, flip to bottom
      verticalTranslate = '0'
      if (y + measured.height > vh - margin) {
        y = vh - margin - measured.height
      }
    }

    // 4. Update DOM directly synchronously, bypassing React state update cycle to eliminate flickering
    el.style.left = `${x}px`
    el.style.top = `${y}px`
    el.style.transform = `translate(-50%, ${verticalTranslate})`
    el.style.opacity = '1'
  }, [mouseX, mouseY, content])

  return createPortal(
    <div 
      ref={tooltipRef} 
      className="token-tooltip" 
      style={{ 
        position: 'fixed',
        left: mouseX,
        top: mouseY,
        opacity: 0, // Initially transparent, waiting for calculation to complete
        pointerEvents: 'none',
        zIndex: 10000
      }}
    >
      {content}
    </div>,
    document.body
  )
}

// MessageRow replaces MessageItem for fine-grained reactivity

interface ChatPanelProps {
  store: AppStore
  panelId: string
  sessionIds: string[]
  activeSessionId: string | null
  onSelectSession: (sessionId: string) => void
  onRequestCloseTabs?: (tabIds: string[]) => void
  onLayoutHeaderMouseDown?: (event: React.MouseEvent<HTMLElement>) => void
  onLayoutHeaderContextMenu?: (event: React.MouseEvent<HTMLElement>) => void
}

export const ChatPanel: React.FC<ChatPanelProps> = observer(({
  store,
  panelId,
  sessionIds,
  activeSessionId,
  onSelectSession,
  onRequestCloseTabs,
  onLayoutHeaderMouseDown,
  onLayoutHeaderContextMenu
}) => {
  const scrollRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const richInputRef = useRef<RichInputHandle>(null)
  const profileSelectRef = useRef<SelectHandle>(null)
  const [inputEmpty, setInputEmpty] = useState(true)

  const checkInputEmpty = useCallback((draft?: ComposerDraft) => {
    const current = draft || richInputRef.current?.getDraft() || { text: '', images: [] }
    setInputEmpty(!(current.text.trim().length > 0 || current.images.length > 0))
  }, [])
  const [showHistory, setShowHistory] = useState(false)
  const [shouldAutoScroll, setShouldAutoScroll] = useState(true)
  const [rollbackTarget, setRollbackTarget] = useState<ChatMessage | null>(null)
  const [queueEditTarget, setQueueEditTarget] = useState<QueueItem | null>(null)
  const [mousePos, setMousePos] = useState<{ x: number; y: number } | null>(null)
  const [showExportMenu, setShowExportMenu] = useState(false)
  const [exportMenuPos, setExportMenuPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 })
  const exportMenuButtonRef = useRef<HTMLButtonElement>(null)
  const exportMenuRef = useRef<HTMLDivElement>(null)
  const t = store.i18n.t
  const contextMenuId = React.useMemo(() => `chat-panel-${panelId}`, [panelId])
  
  // Get active session
  const activeSession = store.chat.getSessionById(activeSessionId)
  const isOverlayOpen = store.view !== 'main'
  const messageIds = activeSession?.messageIds || []
  const isThinking = activeSession?.isThinking || false
  const isQueueMode = activeSessionId ? store.chat.queue.isQueueMode(activeSessionId) : false
  const queueItems = activeSessionId ? store.chat.queue.getQueue(activeSessionId) : []
  const isQueueRunning = activeSessionId ? store.chat.queue.isRunning(activeSessionId) : false
  const inputDisabled = !activeSessionId
  const canQueueRun = isQueueMode && !isQueueRunning && queueItems.length > 0
  const primaryDisabled = isQueueMode ? (inputEmpty && !canQueueRun) : inputEmpty
  const latestTokens = store.chat.getLatestTokens(activeSessionId)
  const latestMaxTokens = store.chat.getLatestMaxTokens(activeSessionId)
  const askLabels = {
    allow: t.common.allow,
    deny: t.common.deny,
    allowed: t.common.allowed,
    denied: t.common.denied
  }

  const renderItems = (() => {
    if (!activeSession) return []
    const items: Array<{ kind: 'message'; id: string }> = []

    messageIds.forEach((msgId) => {
      const msg = activeSession.messagesById.get(msgId)
      if (!msg) return
      if (msg.type === 'tokens_count') return
      items.push({ kind: 'message', id: msgId })
    })

    return items
  })()

  const handleScroll = () => {
    if (scrollRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = scrollRef.current
      // If within 50px of bottom, enable auto-scroll
      const isAtBottom = scrollHeight - scrollTop - clientHeight < 50
      setShouldAutoScroll(isAtBottom)
    }
  }

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current && activeSession) {
      const lastMsgId = messageIds[messageIds.length - 1]
      const lastMsg = lastMsgId ? activeSession.messagesById.get(lastMsgId) : null
      const isNewUserMsg = lastMsg?.role === 'user'
      
      if (isNewUserMsg || shouldAutoScroll) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight
        if (isNewUserMsg) setShouldAutoScroll(true)
      }
    }
  }, [messageIds.length, activeSession])

  // Auto-resize input - removed as RichInput handles its own size via contentEditable

  const normalizeInputImages = (
    images: Array<InputImageAttachment & { localFile?: File }>
  ): InputImageAttachment[] =>
    images
      .map((item) => ({
        ...(item.attachmentId ? { attachmentId: item.attachmentId } : {}),
        ...(item.fileName ? { fileName: item.fileName } : {}),
        ...(item.mimeType ? { mimeType: item.mimeType } : {}),
        ...(typeof item.sizeBytes === 'number' ? { sizeBytes: item.sizeBytes } : {}),
        ...(item.sha256 ? { sha256: item.sha256 } : {}),
        ...(item.previewDataUrl ? { previewDataUrl: item.previewDataUrl } : {}),
        ...(item.status ? { status: item.status } : {}),
        ...(item.localFile instanceof File ? { localFile: item.localFile } : {})
      }))
      .filter((item) => !!String(item.attachmentId || '').trim() || (item as any).localFile instanceof File)

  const handleSendNormal = async (draft: ComposerDraft) => {
    if (!draft.text.trim() && draft.images.length === 0) return
    if (!activeSessionId) return
    const sent = await store.sendChatMessage(
      activeSessionId,
      {
        text: draft.text,
        ...(draft.images.length > 0 ? { images: normalizeInputImages(draft.images) } : {})
      },
      { mode: 'normal' }
    )
    if (!sent) return
    richInputRef.current?.clear()
    setInputEmpty(true)
  }

  const handleQueueAdd = (draft: ComposerDraft) => {
    if (!draft.text.trim() && draft.images.length === 0) return
    if (!activeSessionId) return
    store.chat.addQueueItem(activeSessionId, draft.text, normalizeInputImages(draft.images))
    richInputRef.current?.clear()
    setInputEmpty(true)
  }

  const handleQueueRun = () => {
    if (!activeSessionId) return
    store.chat.startQueue(activeSessionId)
  }

  const handlePrimaryAction = async () => {
    const draft = richInputRef.current?.getDraft() || { text: '', images: [] }
    if (isQueueMode) {
      if (draft.text.trim() || draft.images.length > 0) {
        handleQueueAdd(draft)
      } else if (!isThinking && queueItems.length > 0 && !isQueueRunning) {
        handleQueueRun()
      }
      return
    }
    if (draft.text.trim() || draft.images.length > 0) {
      await handleSendNormal(draft)
    }
  }

  const shouldShowInlinePrimaryWhileThinking = isThinking && !inputEmpty
  const shouldShowPrimaryIdle = !isThinking
  const shouldShowPrimary = shouldShowInlinePrimaryWhileThinking || shouldShowPrimaryIdle
  const useQueueAddIcon = isQueueMode && !inputEmpty
  const shouldShowStop = isThinking
  const runtimeActionCount = (shouldShowPrimary ? 1 : 0) + (shouldShowStop ? 1 : 0)

  const computeExportMenuPosition = useCallback(() => {
    const button = exportMenuButtonRef.current
    if (!button) return
    const rect = button.getBoundingClientRect()
    const menuWidth = exportMenuRef.current?.offsetWidth || 180
    const menuHeight = exportMenuRef.current?.offsetHeight || 128
    const margin = 8
    const left = Math.max(margin, Math.min(rect.left, window.innerWidth - margin - menuWidth))
    const top = Math.min(rect.bottom + 2, window.innerHeight - margin - menuHeight)
    setExportMenuPos({ top, left })
  }, [])

  const toggleExportMenu = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (showExportMenu) {
      setShowExportMenu(false)
      return
    }
    setShowExportMenu(true)
  }

  const handleHistoryExport = async (mode: 'simple' | 'detailed') => {
    if (!activeSessionId) return
    try {
      await window.gyshell.agent.exportHistory(activeSessionId, mode)
    } catch (error) {
      console.error('Failed to export history:', error)
    } finally {
      setShowExportMenu(false)
    }
  }

  const handleCopySessionId = async () => {
    const sessionId = activeSession?.id || activeSessionId
    if (!sessionId) {
      setShowExportMenu(false)
      return
    }
    try {
      await navigator.clipboard.writeText(sessionId)
    } catch (error) {
      console.error('Failed to copy session ID:', error)
    } finally {
      setShowExportMenu(false)
    }
  }

  const stopCurrentRun = () => {
    if (activeSessionId) {
      store.chat.stopQueue(activeSessionId)
      window.gyshell.agent.stopTask(activeSessionId)
      // Optimistically stop thinking in UI
      store.chat.setThinking(false, activeSessionId)
    }
  }

  const renderPrimaryAction = () => (
    <button className="icon-btn-sm primary" onClick={() => { void handlePrimaryAction() }} disabled={shouldShowPrimaryIdle ? primaryDisabled : false}>
      {useQueueAddIcon ? (
        <Plus size={16} strokeWidth={2} />
      ) : isQueueMode ? (
        <Play size={16} strokeWidth={2} />
      ) : (
        <CornerDownLeft size={16} strokeWidth={2} />
      )}
    </button>
  )

  const renderStopAction = () => (
    <button className="icon-btn-sm danger" onClick={stopCurrentRun}>
      <Square size={16} fill="currentColor" />
    </button>
  )

  const isLayoutDragSource = store.layout.draggingPanelId === panelId

  const profiles = store.settings?.models.profiles || []
  const activeProfileId = store.settings?.models.activeProfileId
  const lockedProfileId = activeSession?.lockedProfileId || null
  const profileSelectorValue = lockedProfileId || activeProfileId || ''
  const profileSelectorDisabled = Boolean(activeSession?.isSessionBusy && lockedProfileId)

  const handleAskDecision = async (messageId: string, decision: 'allow' | 'deny') => {
    const sessionId = activeSession?.id
    if (!sessionId) return
    
    const msg = activeSession.messagesById.get(messageId)
    if (msg?.backendMessageId) {
      // 1. Immediately remove from UI for instant feedback
      store.chat.removeMessage(messageId, sessionId)
      // 2. Send decision using backendMessageId
      console.log(`[ChatPanel] Sending decision ${decision} for feedbackId=${msg.backendMessageId}`);
      await window.gyshell.agent.replyMessage(msg.backendMessageId, { decision })
    }
  }

  const handleRollbackConfirm = async () => {
    if (!rollbackTarget || !activeSession?.id) return
    const backendMessageId = rollbackTarget.backendMessageId
    if (!backendMessageId) return
    try {
      await window.gyshell.agent.rollbackToMessage(activeSession.id, backendMessageId)
      store.chat.rollbackToMessage(activeSession.id, backendMessageId)
      richInputRef.current?.setDraft({
        text: rollbackTarget.content || '',
        images: normalizeInputImages((rollbackTarget.metadata?.inputImages || []) as Array<InputImageAttachment & { localFile?: File }>)
      })
      setInputEmpty(false)
    } catch (error) {
      console.error('Failed to rollback message:', error)
    } finally {
      setRollbackTarget(null)
    }
  }

  const handleQueueEditRequest = (item: QueueItem) => {
    const currentDraft = richInputRef.current?.getDraft() || { text: '', images: [] }
    if (currentDraft.text.trim() || currentDraft.images.length > 0) {
      setQueueEditTarget(item)
      return
    }
    if (!activeSessionId) return
    store.chat.removeQueueItem(activeSessionId, item.id)
    richInputRef.current?.setDraft({ text: item.content, images: item.images || [] })
    setInputEmpty(false)
  }

  const handleQueueEditConfirm = () => {
    if (!queueEditTarget || !activeSessionId) return
    store.chat.removeQueueItem(activeSessionId, queueEditTarget.id)
    richInputRef.current?.setDraft({
      text: queueEditTarget.content,
      images: queueEditTarget.images || []
    })
    setInputEmpty(false)
    setQueueEditTarget(null)
  }

  useEffect(() => {
    if (!queueEditTarget) return
    if (!queueItems.some((item) => item.id === queueEditTarget.id)) {
      setQueueEditTarget(null)
    }
  }, [queueEditTarget, queueItems])

  useEffect(() => {
    const panelEl = panelRef.current
    if (!panelEl) return

    const getSelectionText = () => {
      // In rich input mode, we just use window selection
      return window.getSelection()?.toString() || ''
    }

    const handleContextMenu = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('.panel-header-minimal')) {
        return
      }
      event.preventDefault()
      const selectionText = getSelectionText()
      window.gyshell.ui.showContextMenu({
        id: contextMenuId,
        canCopy: selectionText.trim().length > 0,
        canPaste: true
      })
    }

    const onContextMenuAction = (data: { id: string; action: 'copy' | 'paste' }) => {
      if (data.id !== contextMenuId) return
      if (data.action === 'copy') {
        const selectionText = getSelectionText()
        if (selectionText) {
          navigator.clipboard.writeText(selectionText).catch(() => {
            // ignore
          })
        }
        return
      }
      if (data.action === 'paste') {
         navigator.clipboard.readText().then((text) => {
           if (text) {
             // We don't have an easy way to insert into RichInput from here
             // but RichInput handles Ctrl+V itself. This is for context menu.
             // For now, we just append or ignore if not focused.
           }
         }).catch(() => {
           // ignore
         })
      }
    }

    panelEl.addEventListener('contextmenu', handleContextMenu)
    const removeContextMenuListener = window.gyshell.ui.onContextMenuAction(onContextMenuAction)
    return () => {
      panelEl.removeEventListener('contextmenu', handleContextMenu)
      removeContextMenuListener()
    }
  }, [contextMenuId])

  useEffect(() => {
    if (!showExportMenu) return
    computeExportMenuPosition()

    const onDocMouseDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (exportMenuRef.current?.contains(target)) return
      if (exportMenuButtonRef.current?.contains(target)) return
      setShowExportMenu(false)
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShowExportMenu(false)
      }
    }

    const onReflow = () => computeExportMenuPosition()

    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', onReflow)
    window.addEventListener('scroll', onReflow, true)

    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', onReflow)
      window.removeEventListener('scroll', onReflow, true)
    }
  }, [showExportMenu, computeExportMenuPosition])

  return (
    <div 
      className={`panel panel-chat${isLayoutDragSource ? ' is-dragging-source' : ''}`} 
      ref={panelRef}
    >
      <div
        className="panel-header-minimal is-draggable"
        onMouseDown={onLayoutHeaderMouseDown}
        onContextMenu={onLayoutHeaderContextMenu}
        title={t.chat.dragHint}
        aria-label={t.chat.dragHint}
      >
        <div
          className="panel-tab-drag-handle"
          aria-hidden="true"
        >
          <GripVertical size={12} strokeWidth={2.4} />
        </div>
        <div
          className="chat-tabs"
          data-layout-tab-bar="true"
          data-layout-tab-panel-id={panelId}
          data-layout-tab-kind="chat"
        >
          {sessionIds.map((sessionId, index) => {
            const session = store.chat.getSessionById(sessionId)
            if (!session) return null
            return (
              <div
                key={session.id}
                className={`chat-tab ${session.id === activeSessionId ? 'active' : ''}`}
                style={{ maxWidth: `${CHAT_PANEL_SESSION_TITLE_CHAR_LIMIT + 8}ch` }}
                onClick={() => onSelectSession(session.id)}
                draggable
                data-layout-tab-draggable="true"
                data-layout-tab-id={session.id}
                data-layout-tab-kind="chat"
                data-layout-tab-panel-id={panelId}
                data-layout-tab-index={index}
              >
                <span className="chat-tab-title">{formatChatPanelSessionTitle(session.title)}</span>
                <button
                  className="chat-tab-close"
                  onClick={(event) => {
                    event.stopPropagation()
                    if (onRequestCloseTabs) {
                      onRequestCloseTabs([session.id])
                      return
                    }
                    store.chat.closeSession(session.id)
                  }}
                >
                  <X size={12} />
                </button>
              </div>
            )
          })}
        </div>
        <button
          className="chat-tab-add"
          onClick={() => {
            const sessionId = store.chat.createSession()
            store.layout.attachTabToPanel('chat', sessionId, panelId)
          }}
        >
          <Plus size={14} />
        </button>
        <button className="chat-tab-history" onClick={() => setShowHistory(true)}>
          <History size={14} />
        </button>
        <button
          ref={exportMenuButtonRef}
          className="chat-tab-history-menu"
          onClick={toggleExportMenu}
          title={t.chat.history.exportMenuTitle}
          aria-label={t.chat.history.exportMenuTitle}
          aria-haspopup="menu"
          aria-expanded={showExportMenu}
        >
          <MoreVertical size={14} />
        </button>
      </div>

      {showExportMenu && createPortal(
        <div
          ref={exportMenuRef}
          className="win-select-menu chat-export-menu"
          role="menu"
          style={{ top: exportMenuPos.top, left: exportMenuPos.left }}
        >
          <button
            type="button"
            className="win-select-option"
            role="menuitem"
            onClick={() => handleHistoryExport('simple')}
          >
            {t.chat.history.exportSimple}
          </button>
          <button
            type="button"
            className="win-select-option"
            role="menuitem"
            onClick={() => handleHistoryExport('detailed')}
          >
            {t.chat.history.exportDetailed}
          </button>
          <button
            type="button"
            className="win-select-option"
            role="menuitem"
            onClick={handleCopySessionId}
            disabled={!activeSessionId}
          >
            {t.chat.history.copySessionId}
          </button>
        </div>,
        document.body
      )}
      
      {showHistory && <ChatHistoryPanel store={store} onClose={() => setShowHistory(false)} />}

      <ConfirmDialog
        open={!!rollbackTarget}
        title={t.chat.rollback.title}
        message={t.chat.rollback.message}
        confirmText={t.chat.rollback.confirm}
        cancelText={t.chat.rollback.cancel}
        danger
        onCancel={() => setRollbackTarget(null)}
        onConfirm={handleRollbackConfirm}
      />
      <ConfirmDialog
        open={!!queueEditTarget}
        title={t.chat.queue.editConfirmTitle}
        message={t.chat.queue.editConfirmMessage}
        confirmText={t.chat.queue.editConfirm}
        cancelText={t.chat.queue.editCancel}
        onCancel={() => setQueueEditTarget(null)}
        onConfirm={handleQueueEditConfirm}
      />
      
      <div className="panel-body" ref={scrollRef} onScroll={handleScroll}>
        <div className="message-list">
          {renderItems.map((item) => {
            if (!activeSessionId) return null
            return (
              <MessageRow
                key={item.id}
                store={store}
                sessionId={activeSessionId}
                messageId={item.id}
                onAskDecision={handleAskDecision}
                onRollback={(m) => setRollbackTarget(m)}
                askLabels={askLabels}
                isThinking={isThinking}
              />
            )
          })}
          {messageIds.length === 0 && (
            <div className="placeholder">
              {t.chat.placeholder}
            </div>
          )}
        </div>
      </div>

      <div className="chat-input-area">
        {isQueueMode && activeSessionId && queueItems.length > 0 && (
          <div className="queue-area">
            <QueueManager
              items={queueItems}
              isRunning={isQueueRunning}
              onReorder={(fromIndex, toIndex) => store.chat.moveQueueItem(activeSessionId, fromIndex, toIndex)}
              onEdit={handleQueueEditRequest}
              editLabel={t.common.edit}
            />
          </div>
        )}
        <div className="input-container">
            <RichInput
              ref={richInputRef}
              store={store}
              placeholder={t.chat.placeholder}
              onSend={(draft) => {
                if (isQueueMode) {
                  handleQueueAdd(draft)
                  return
                }
                void handleSendNormal(draft)
              }}
              onInput={(draft) => checkInputEmpty(draft)}
              disabled={inputDisabled}
            />
            
            <div className="input-footer">
                <div className="input-left-tools">
                  <div 
                    className={`chat-profile-selector ${profileSelectorDisabled ? 'is-disabled' : ''}`}
                    onClick={() => {
                      if (!profileSelectorDisabled) {
                        profileSelectRef.current?.toggle()
                      }
                    }}
                  >
                      <span className="profile-icon profile-icon-terminal" aria-hidden="true">
                        ❯_
                      </span>
                      <Select
                        ref={profileSelectRef}
                        className="profile-dropdown"
                        value={profileSelectorValue}
                        options={profiles.map((p) => ({ value: p.id, label: p.name }))}
                        disabled={profileSelectorDisabled}
                        onChange={(id) => store.setActiveProfile(id)}
                        // Keep the mac-style "text-only" look for this compact selector
                        hideArrow
                      />
                  </div>
                </div>
                <div className="input-actions">
                  <div className="input-actions-static">
                    <QueueModeSwitch
                      enabled={isQueueMode}
                      disabled={!activeSessionId}
                      onToggle={() => {
                        if (activeSessionId) {
                          store.chat.setQueueMode(activeSessionId, !isQueueMode)
                        }
                      }}
                      labelOn={t.chat.queue.modeQueue}
                      labelOff={t.chat.queue.modeNormal}
                    />
                  </div>
                  <div className="input-actions-runtime">
                    {runtimeActionCount <= 1 ? (
                      <div className="runtime-buttons is-single">
                        {shouldShowPrimary ? renderPrimaryAction() : shouldShowStop ? renderStopAction() : null}
                      </div>
                    ) : (
                      <div className="runtime-buttons is-double">
                        {shouldShowPrimary ? renderPrimaryAction() : null}
                        {shouldShowStop ? renderStopAction() : null}
                      </div>
                    )}
                  </div>
                </div>
            </div>

            {latestTokens > 0 && latestMaxTokens > 0 && (
              <div 
                className="token-progress-bar"
                onMouseMove={(e) => setMousePos({ x: e.clientX, y: e.clientY })}
                onMouseLeave={() => setMousePos(null)}
              >
                <div 
                  className="token-progress-fill" 
                  style={{ width: `${Math.min(100, Math.round((latestTokens / latestMaxTokens) * 100))}%` }}
                />
              </div>
            )}
            {mousePos && !isOverlayOpen && (
              <TokenTooltip 
                mouseX={mousePos.x}
                mouseY={mousePos.y}
                content={`${(latestTokens / 1000).toFixed(1)}k / ${(latestMaxTokens / 1000).toFixed(1)}k    ${Math.round((latestTokens / latestMaxTokens) * 100)}%`}
              />
            )}
        </div>
      </div>
    </div>
  )
})
