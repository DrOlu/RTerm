import React, { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import type { ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import './xtermView.scss'
import type { TerminalConfig } from '../../lib/ipcTypes'
import { isTerminalTrackedByBackend } from './runtimeRetention'
import { resolveTerminalSize } from './terminalDimensions'
import { isRuntimeOwnedByUi } from './runtimeOwnership'
import {
  hasFileSystemPanelDragPayloadType,
  hasNativeFileDragType,
  resolveTerminalDropPathsForTarget
} from '../../lib/filesystemDragDrop'

const SCROLLBAR_HIDE_DELAY = 2000 // ms
const RUNTIME_RELEASE_DELAY = 4000 // ms

type TerminalSettings = {
  fontSize?: number
  lineHeight?: number
  scrollback?: number
  cursorStyle?: 'block' | 'underline' | 'bar'
  cursorBlink?: boolean
  copyOnSelect?: boolean
  rightClickToPaste?: boolean
}

interface TerminalRuntime {
  terminalId: string
  term: Terminal
  fit: FitAddon
  mountEl: HTMLDivElement
  contextMenuId: string
  selectionHandler?: (selectionText: string) => void
  settings?: TerminalSettings
  uiOwnershipCheck?: () => boolean
  isActive: boolean
  hostEl: HTMLDivElement | null
  refCount: number
  releaseTimer: number | null
  scrollHideTimer: number | null
  cleanupBackendData: () => void
  cleanupContextMenuListener: () => void
  inputDispose: () => void
  selectionDispose: () => void
  scrollDispose: () => void
  removeDomListeners: () => void
}

const runtimePool = new Map<string, TerminalRuntime>()

const toPlainConfig = (config: TerminalConfig): TerminalConfig =>
  JSON.parse(JSON.stringify(config)) as TerminalConfig

const clearTimer = (timerId: number | null): void => {
  if (timerId !== null) {
    window.clearTimeout(timerId)
  }
}

const refitRuntime = (runtime: TerminalRuntime): void => {
  const host = runtime.hostEl
  if (!host) return
  if (host.clientWidth <= 0 || host.clientHeight <= 0) return
  try {
    runtime.fit.fit()
    const next = runtime.fit.proposeDimensions()
    const size = resolveTerminalSize(next, {
      cols: runtime.term.cols,
      rows: runtime.term.rows
    })
    window.gyshell.terminal.resize(runtime.terminalId, size.cols, size.rows)
  } catch {
    // ignore transient DOM/layout issues
  }
}

const attachRuntimeToHost = (runtime: TerminalRuntime, hostEl: HTMLDivElement): void => {
  if (runtime.hostEl === hostEl && runtime.mountEl.parentElement === hostEl) return
  if (runtime.mountEl.parentElement && runtime.mountEl.parentElement !== hostEl) {
    runtime.mountEl.parentElement.removeChild(runtime.mountEl)
  }
  hostEl.replaceChildren(runtime.mountEl)
  runtime.hostEl = hostEl
}

const disposeRuntime = (runtime: TerminalRuntime): void => {
  clearTimer(runtime.releaseTimer)
  clearTimer(runtime.scrollHideTimer)
  runtime.releaseTimer = null
  runtime.scrollHideTimer = null
  runtime.cleanupBackendData()
  runtime.cleanupContextMenuListener()
  runtime.inputDispose()
  runtime.selectionDispose()
  runtime.scrollDispose()
  runtime.removeDomListeners()
  runtime.hostEl = null
  runtime.term.dispose()
}

const createRuntime = (
  config: TerminalConfig,
  theme: ITheme,
  settings: TerminalSettings | undefined
): TerminalRuntime => {
  const term = new Terminal({
    allowTransparency: true,
    cursorBlink: settings?.cursorBlink ?? true,
    cursorStyle: settings?.cursorStyle ?? 'block',
    fontSize: settings?.fontSize ?? 14,
    lineHeight: Math.max(1, settings?.lineHeight ?? 1.2),
    scrollback: settings?.scrollback ?? 5000,
    theme,
    allowProposedApi: true
  })

  const fit = new FitAddon()
  term.loadAddon(fit)

  const webLinks = new WebLinksAddon((_event, url) => {
    window.gyshell.system.openExternal(url).catch(() => {
      // ignore
    })
  })
  term.loadAddon(webLinks)

  const mountEl = document.createElement('div')
  mountEl.style.width = '100%'
  mountEl.style.height = '100%'
  mountEl.style.position = 'relative'

  term.open(mountEl)
  try {
    fit.fit()
  } catch {
    // ignore transient DOM/layout issues
  }

  const runtime: TerminalRuntime = {
    terminalId: config.id,
    term,
    fit,
    mountEl,
    contextMenuId: `terminal-${config.id}`,
    selectionHandler: undefined,
    settings,
    uiOwnershipCheck: undefined,
    isActive: false,
    hostEl: null,
    refCount: 0,
    releaseTimer: null,
    scrollHideTimer: null,
    cleanupBackendData: () => {},
    cleanupContextMenuListener: () => {},
    inputDispose: () => {},
    selectionDispose: () => {},
    scrollDispose: () => {},
    removeDomListeners: () => {}
  }

  const showScrollbar = () => {
    runtime.hostEl?.classList.add('is-scrollbar-visible')
    clearTimer(runtime.scrollHideTimer)
    runtime.scrollHideTimer = window.setTimeout(() => {
      runtime.hostEl?.classList.remove('is-scrollbar-visible')
      runtime.scrollHideTimer = null
    }, SCROLLBAR_HIDE_DELAY)
  }

  const inputDisposable = term.onData((data) => {
    window.gyshell.terminal.write(config.id, data)
  })

  const selectionDisposable = term.onSelectionChange(() => {
    const selectionText = term.getSelection()
    runtime.selectionHandler?.(selectionText)
    if (selectionText && runtime.settings?.copyOnSelect) {
      navigator.clipboard.writeText(selectionText).catch(() => {
        // ignore
      })
    }
  })

  const scrollDisposable = term.onScroll(() => {
    showScrollbar()
  })

  const handlePaste = (event: ClipboardEvent) => {
    const selectionText = term.getSelection()
    if (selectionText) {
      event.preventDefault()
      navigator.clipboard
        .writeText(selectionText)
        .then(() => {
          term.paste(selectionText)
        })
        .catch(() => {
          term.paste(selectionText)
        })
    }
  }

  const handleDragOver = (event: DragEvent) => {
    const isFileDrop =
      hasFileSystemPanelDragPayloadType(event.dataTransfer) || hasNativeFileDragType(event.dataTransfer)
    if (!isFileDrop) return
    event.preventDefault()
    event.stopPropagation()
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy'
    }
  }

  const handleDrop = (event: DragEvent) => {
    const isFileDrop =
      hasFileSystemPanelDragPayloadType(event.dataTransfer) || hasNativeFileDragType(event.dataTransfer)
    if (!isFileDrop) return
    event.preventDefault()
    event.stopPropagation()
    const paths = resolveTerminalDropPathsForTarget(event.dataTransfer, config.id)
    if (!paths.length) return
    window.gyshell.terminal.writePaths(config.id, paths).catch(() => {
      // ignore
    })
  }

  const handleContextMenu = (event: MouseEvent) => {
    if (runtime.settings?.rightClickToPaste) {
      event.preventDefault()
      navigator.clipboard.readText().then((text) => {
        if (text) term.paste(text)
      }).catch(() => {
        // ignore
      })
      return
    }
    event.preventDefault()
    const selectionText = term.getSelection()
    window.gyshell.ui.showContextMenu({
      id: runtime.contextMenuId,
      canCopy: selectionText.trim().length > 0,
      canPaste: true
    })
  }

  const onContextMenuAction = (data: { id: string; action: 'copy' | 'paste' }) => {
    if (data.id !== runtime.contextMenuId) return
    if (data.action === 'copy') {
      const selectionText = term.getSelection()
      if (selectionText) {
        navigator.clipboard.writeText(selectionText).catch(() => {
          // ignore
        })
      }
      return
    }
    if (data.action === 'paste') {
      const selectionText = term.getSelection()
      if (selectionText) {
        navigator.clipboard
          .writeText(selectionText)
          .then(() => {
            term.paste(selectionText)
          })
          .catch(() => {
            term.paste(selectionText)
          })
        return
      }
      navigator.clipboard.readText().then((text) => {
        if (text) term.paste(text)
      }).catch(() => {
        // ignore
      })
    }
  }

  mountEl.addEventListener('paste', handlePaste)
  mountEl.addEventListener('dragover', handleDragOver, true)
  mountEl.addEventListener('drop', handleDrop, true)
  mountEl.addEventListener('contextmenu', handleContextMenu)
  const removeContextMenuListener = window.gyshell.ui.onContextMenuAction(onContextMenuAction)

  let lastBufferOffset = 0
  let isSyncingInitialBuffer = true
  const pendingLiveEvents: Array<{ data: string; offset?: number }> = []
  const writeDataWithOffset = (data: string, offset?: number): void => {
    if (!data) return
    if (!Number.isFinite(offset)) {
      term.write(data)
      return
    }

    const normalizedOffset = Math.max(0, Math.floor(offset as number))
    const chunkStart = Math.max(0, normalizedOffset - data.length)
    if (normalizedOffset <= lastBufferOffset) {
      return
    }
    if (chunkStart < lastBufferOffset) {
      const overlap = lastBufferOffset - chunkStart
      const nextChunk = data.slice(Math.max(0, overlap))
      if (nextChunk) {
        term.write(nextChunk)
      }
      lastBufferOffset = normalizedOffset
      return
    }
    term.write(data)
    lastBufferOffset = normalizedOffset
  }

  const cleanup = window.gyshell.terminal.onData(({ terminalId, data, offset }) => {
    if (terminalId === config.id) {
      if (isSyncingInitialBuffer) {
        pendingLiveEvents.push({ data, offset })
        return
      }
      writeDataWithOffset(data, offset)
    }
  })

  const plainConfig = toPlainConfig(config)
  const dims = fit.proposeDimensions()
  const size = resolveTerminalSize(dims, {
    cols: term.cols,
    rows: term.rows
  })
  window.gyshell.terminal.createTab({ ...plainConfig, cols: size.cols, rows: size.rows }).catch(() => {
    // ignore: backend is idempotent and may fail during hot reload; user will see logs in devtools
  })
  window.gyshell.terminal.resize(config.id, size.cols, size.rows).catch(() => {
    // ignore
  })

  const syncBufferedOutput = async (): Promise<void> => {
    try {
      const initial = await window.gyshell.terminal.getBufferDelta(config.id, 0)
      writeDataWithOffset(initial.data || '', initial.offset)

      const normalizedOffset = Math.max(lastBufferOffset, Number.isFinite(initial.offset) ? Math.floor(initial.offset) : 0)
      lastBufferOffset = normalizedOffset
      const tail = await window.gyshell.terminal.getBufferDelta(config.id, normalizedOffset)
      writeDataWithOffset(tail.data || '', tail.offset)
    } catch {
      // ignore: runtime output sync is best-effort
    } finally {
      isSyncingInitialBuffer = false
      if (pendingLiveEvents.length > 0) {
        const pending = pendingLiveEvents.splice(0, pendingLiveEvents.length)
        pending.forEach((event) => writeDataWithOffset(event.data, event.offset))
      }
    }
  }
  void syncBufferedOutput()

  runtime.cleanupBackendData = cleanup
  runtime.cleanupContextMenuListener = removeContextMenuListener
  runtime.inputDispose = () => inputDisposable.dispose()
  runtime.selectionDispose = () => selectionDisposable.dispose()
  runtime.scrollDispose = () => scrollDisposable.dispose()
  runtime.removeDomListeners = () => {
    mountEl.removeEventListener('paste', handlePaste)
    mountEl.removeEventListener('dragover', handleDragOver, true)
    mountEl.removeEventListener('drop', handleDrop, true)
    mountEl.removeEventListener('contextmenu', handleContextMenu)
  }

  return runtime
}

const acquireRuntime = (
  config: TerminalConfig,
  theme: ITheme,
  settings: TerminalSettings | undefined,
  uiOwnershipCheck?: () => boolean
): TerminalRuntime => {
  let runtime = runtimePool.get(config.id)
  if (!runtime) {
    runtime = createRuntime(config, theme, settings)
    runtimePool.set(config.id, runtime)
  }
  if (uiOwnershipCheck) {
    runtime.uiOwnershipCheck = uiOwnershipCheck
  }
  runtime.refCount += 1
  clearTimer(runtime.releaseTimer)
  runtime.releaseTimer = null
  return runtime
}

const releaseRuntime = (
  terminalId: string,
  options?: {
    decrementRefCount?: boolean
  }
): void => {
  const runtime = runtimePool.get(terminalId)
  if (!runtime) return
  if (options?.decrementRefCount !== false) {
    runtime.refCount = Math.max(0, runtime.refCount - 1)
  }
  if (runtime.refCount > 0) return

  clearTimer(runtime.releaseTimer)
  runtime.releaseTimer = window.setTimeout(() => {
    const pending = runtimePool.get(terminalId)
    if (!pending || pending.refCount > 0) return
    if (!isRuntimeOwnedByUi(pending.uiOwnershipCheck)) {
      disposeRuntime(pending)
      runtimePool.delete(terminalId)
      return
    }

    isTerminalTrackedByBackend(terminalId).then((stillTrackedByBackend) => {
      const latest = runtimePool.get(terminalId)
      if (!latest || latest.refCount > 0) return
      if (!isRuntimeOwnedByUi(latest.uiOwnershipCheck)) {
        disposeRuntime(latest)
        runtimePool.delete(terminalId)
        return
      }

      if (stillTrackedByBackend) {
        latest.releaseTimer = window.setTimeout(() => {
          releaseRuntime(terminalId, { decrementRefCount: false })
        }, RUNTIME_RELEASE_DELAY)
        return
      }

      disposeRuntime(latest)
      runtimePool.delete(terminalId)
    })
  }, RUNTIME_RELEASE_DELAY)
}

export function XTermView(props: {
  config: TerminalConfig
  theme: ITheme
  terminalSettings?: TerminalSettings
  isOwnedByUi?: () => boolean
  isActive?: boolean
  layoutSignature?: string
  onSelectionChange?: (selectionText: string) => void
}): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null)
  const runtimeRef = useRef<TerminalRuntime | null>(null)

  const refitTerminal = React.useCallback(() => {
    const runtime = runtimeRef.current
    if (!runtime) return
    refitRuntime(runtime)
  }, [])

  useEffect(() => {
    const hostEl = hostRef.current
    if (!hostEl) return

    const runtime = acquireRuntime(props.config, props.theme, props.terminalSettings, props.isOwnedByUi)
    runtime.selectionHandler = props.onSelectionChange
    runtime.settings = props.terminalSettings
    runtime.uiOwnershipCheck = props.isOwnedByUi
    runtime.isActive = props.isActive ?? false
    runtimeRef.current = runtime
    attachRuntimeToHost(runtime, hostEl)

    const handleResize = () => {
      const activeRuntime = runtimeRef.current
      if (!activeRuntime?.isActive) return
      refitTerminal()
    }

    window.addEventListener('resize', handleResize)
    const resizeObserver =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            const activeRuntime = runtimeRef.current
            if (!activeRuntime?.isActive) return
            refitTerminal()
          })
        : null
    resizeObserver?.observe(hostEl)

    return () => {
      window.removeEventListener('resize', handleResize)
      resizeObserver?.disconnect()
      hostEl.classList.remove('is-scrollbar-visible')
      const activeRuntime = runtimeRef.current
      if (activeRuntime && activeRuntime.terminalId === props.config.id) {
        runtimeRef.current = null
      }
      releaseRuntime(props.config.id)
    }
  }, [props.config.id, refitTerminal])

  useEffect(() => {
    const runtime = runtimeRef.current
    if (!runtime) return
    runtime.selectionHandler = props.onSelectionChange
  }, [props.onSelectionChange, props.config.id])

  useEffect(() => {
    const runtime = runtimeRef.current
    if (!runtime) return
    runtime.settings = props.terminalSettings
  }, [props.terminalSettings, props.config.id])

  useEffect(() => {
    const runtime = runtimeRef.current
    if (!runtime) return
    runtime.uiOwnershipCheck = props.isOwnedByUi
  }, [props.isOwnedByUi, props.config.id])

  useEffect(() => {
    const runtime = runtimeRef.current
    if (!runtime) return
    runtime.isActive = props.isActive ?? false
  }, [props.isActive, props.config.id])

  // Live-update theme (Tabby-style behavior)
  useEffect(() => {
    const runtime = runtimeRef.current
    if (!runtime) return
    runtime.term.options.theme = props.theme
  }, [props.theme, props.config.id])

  // Live-update terminal settings
  useEffect(() => {
    const runtime = runtimeRef.current
    if (!runtime) return
    runtime.settings = props.terminalSettings
    const options = runtime.term.options
    if (props.terminalSettings?.fontSize) options.fontSize = props.terminalSettings.fontSize
    if (props.terminalSettings?.lineHeight) options.lineHeight = Math.max(1, props.terminalSettings.lineHeight)
    if (props.terminalSettings?.scrollback) options.scrollback = props.terminalSettings.scrollback
    if (props.terminalSettings?.cursorStyle) options.cursorStyle = props.terminalSettings.cursorStyle
    if (props.terminalSettings?.cursorBlink !== undefined) options.cursorBlink = props.terminalSettings.cursorBlink

    // Refit after changes
    requestAnimationFrame(() => {
      if (!props.isActive) return
      const activeRuntime = runtimeRef.current
      if (!activeRuntime || activeRuntime.terminalId !== props.config.id) return
      refitTerminal()
    })
  }, [
    props.terminalSettings?.fontSize,
    props.terminalSettings?.lineHeight,
    props.terminalSettings?.scrollback,
    props.terminalSettings?.cursorStyle,
    props.terminalSettings?.cursorBlink,
    props.config.id,
    props.isActive,
    refitTerminal
  ])

  // Re-fit when the tab becomes active (Tabby-like behavior)
  useEffect(() => {
    if (!props.isActive) return
    const runtime = runtimeRef.current
    if (!runtime || runtime.terminalId !== props.config.id) return
    requestAnimationFrame(() => {
      const activeRuntime = runtimeRef.current
      if (!activeRuntime || activeRuntime.terminalId !== props.config.id) return
      refitTerminal()
    })
  }, [props.isActive, props.layoutSignature, props.config.id, refitTerminal])

  return <div className="xterm-host" ref={hostRef} />
}
