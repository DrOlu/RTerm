import React from 'react'
import { GripVertical, Save, X } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import type { AppStore } from '../../stores/AppStore'
import './fileEditor.scss'

interface FileEditorPanelProps {
  store: AppStore
  panelId: string
  onLayoutHeaderMouseDown?: (event: React.MouseEvent<HTMLElement>) => void
  onLayoutHeaderContextMenu?: (event: React.MouseEvent<HTMLElement>) => void
}

const replaceSelectionInTextarea = (
  textarea: HTMLTextAreaElement,
  text: string,
  onNextValue: (nextValue: string) => void
): void => {
  const selectionStart = textarea.selectionStart ?? 0
  const selectionEnd = textarea.selectionEnd ?? selectionStart
  const value = textarea.value || ''
  const nextValue = `${value.slice(0, selectionStart)}${text}${value.slice(selectionEnd)}`
  onNextValue(nextValue)

  const nextCursor = selectionStart + text.length
  queueMicrotask(() => {
    textarea.focus()
    textarea.setSelectionRange(nextCursor, nextCursor)
  })
}

export const FileEditorPanel: React.FC<FileEditorPanelProps> = observer(({
  store,
  panelId,
  onLayoutHeaderMouseDown,
  onLayoutHeaderContextMenu
}) => {
  const t = store.i18n.t
  const fileEditor = store.fileEditor
  const isLayoutDragSource = store.layout.isDragging && store.layout.draggingPanelId === panelId
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null)
  const contextMenuId = React.useMemo(() => `file-editor:${panelId}`, [panelId])

  const closePanel = React.useCallback(() => {
    if (!store.layout.canRemovePanel(panelId)) {
      return
    }
    if (!store.canClosePanel('fileEditor')) {
      return
    }
    store.layout.removePanel(panelId)
    store.onPanelRemoved('fileEditor')
  }, [panelId, store])

  const canSave = fileEditor.canSave
  const currentPath = fileEditor.filePath || ''

  React.useEffect(() => {
    const removeListener = window.gyshell.ui.onContextMenuAction((payload) => {
      if (payload.id !== contextMenuId) return
      const textarea = textareaRef.current
      if (!textarea) return

      if (payload.action === 'copy') {
        const selectionStart = textarea.selectionStart ?? 0
        const selectionEnd = textarea.selectionEnd ?? selectionStart
        if (selectionEnd <= selectionStart) return
        const selectedText = textarea.value.slice(selectionStart, selectionEnd)
        if (!selectedText) return
        navigator.clipboard.writeText(selectedText).catch(() => {
          // ignore
        })
        return
      }

      navigator.clipboard.readText().then((clipboardText) => {
        if (!clipboardText) return
        replaceSelectionInTextarea(textarea, clipboardText, (nextValue) => {
          fileEditor.updateContent(nextValue)
        })
      }).catch(() => {
        // ignore
      })
    })
    return () => {
      removeListener()
    }
  }, [contextMenuId, fileEditor])

  return (
    <div className={`panel panel-file-editor${isLayoutDragSource ? ' is-dragging-source' : ''}`}>
      <div
        className="file-editor-header is-draggable"
        onMouseDown={onLayoutHeaderMouseDown}
        onContextMenu={onLayoutHeaderContextMenu}
      >
        <div className="panel-tab-drag-handle" aria-hidden="true">
          <GripVertical size={12} strokeWidth={2.4} />
        </div>
        <div className="file-editor-header-main">
          <span className="file-editor-title">{t.fileEditor.title}</span>
          {currentPath ? <span className="file-editor-path">{currentPath}</span> : null}
        </div>
        {fileEditor.mode === 'text' && fileEditor.dirty ? (
          <span className="file-editor-dirty">{t.fileEditor.unsavedChanges}</span>
        ) : null}
        <button
          className="icon-btn-sm primary"
          title={t.common.save}
          onClick={() => {
            void fileEditor.save()
          }}
          disabled={!canSave}
        >
          <Save size={14} strokeWidth={2} />
        </button>
        <button className="icon-btn-sm" title={t.common.close} onClick={closePanel}>
          <X size={14} strokeWidth={2} />
        </button>
      </div>

      <div className="file-editor-status-bar">
        {fileEditor.errorMessage ? (
          <span className="file-editor-status-error">{fileEditor.errorMessage}</span>
        ) : fileEditor.statusMessage ? (
          <span className="file-editor-status-message">{fileEditor.statusMessage}</span>
        ) : (
          <span className="file-editor-status-placeholder" />
        )}
      </div>

      <div className="panel-body file-editor-body">
        {!fileEditor.hasActiveDocument || fileEditor.mode === 'idle' ? (
          <div className="file-editor-empty-state">{t.fileEditor.emptyHint}</div>
        ) : fileEditor.mode === 'loading' ? (
          <div className="file-editor-empty-state">{t.fileEditor.loadingPreview}</div>
        ) : fileEditor.mode === 'error' ? (
          <div className="file-editor-error">{fileEditor.errorMessage || t.fileEditor.previewErrorFallback}</div>
        ) : (
          <textarea
            ref={textareaRef}
            className="file-editor-textarea"
            value={fileEditor.content}
            onChange={(event) => fileEditor.updateContent(event.target.value)}
            onContextMenu={(event) => {
              event.preventDefault()
              const textarea = textareaRef.current
              const selectionStart = textarea?.selectionStart ?? 0
              const selectionEnd = textarea?.selectionEnd ?? selectionStart
              void window.gyshell.ui.showContextMenu({
                id: contextMenuId,
                canCopy: selectionEnd > selectionStart,
                canPaste: true
              })
            }}
            onKeyDown={(event) => {
              const isSaveShortcut = (event.metaKey || event.ctrlKey)
                && !event.altKey
                && event.key.toLowerCase() === 's'
              if (!isSaveShortcut) return
              event.preventDefault()
              void fileEditor.save()
            }}
            disabled={fileEditor.busy}
          />
        )}
      </div>
    </div>
  )
})

