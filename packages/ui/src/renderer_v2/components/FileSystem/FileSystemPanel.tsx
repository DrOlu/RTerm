import React from 'react'
import {
  ArrowUp,
  Check,
  Copy,
  File,
  FileText,
  Folder,
  FolderPlus,
  GripVertical,
  Pencil,
  RefreshCw,
  Scissors,
  Trash2,
  X
} from 'lucide-react'
import { observer } from 'mobx-react-lite'
import type { FileSystemEntry } from '../../lib/ipcTypes'
import type { AppStore, TerminalTabModel } from '../../stores/AppStore'
import { resolveTextPreviewSupport, TEXT_PREVIEW_MAX_BYTES } from './filePreviewSupport'
import { ConfirmDialog } from '../Common/ConfirmDialog'
import './filesystem.scss'

interface FileSystemPanelProps {
  store: AppStore
  panelId: string
  tabs: TerminalTabModel[]
  activeTabId: string | null
  onSelectTab: (tabId: string) => void
  onLayoutHeaderMouseDown?: (event: React.MouseEvent<HTMLElement>) => void
  onLayoutHeaderContextMenu?: (event: React.MouseEvent<HTMLElement>) => void
}

interface BrowserTabState {
  hasBootstrapped: boolean
  currentPath: string
  pathInput: string
  entries: FileSystemEntry[]
  loading: boolean
  busy: boolean
  errorMessage: string | null
  selectedPaths: string[]
  selectionAnchorPath: string | null
  statusMessage: string | null
}

const createInitialTabState = (): BrowserTabState => ({
  hasBootstrapped: false,
  currentPath: '',
  pathInput: '',
  entries: [],
  loading: false,
  busy: false,
  errorMessage: null,
  selectedPaths: [],
  selectionAnchorPath: null,
  statusMessage: null
})

const STATUS_UPDATE_MIN_INTERVAL_MS = 120
const STATUS_UPDATE_MIN_PERCENT_STEP = 2
const TRANSFER_CONCURRENCY_LIMIT = 2
const TRANSFER_CANCELLED_ERROR_CODE = 'GYSHELL_FS_TRANSFER_CANCELLED'
const TERMINAL_TRANSFER_STATUSES = new Set<TransferTaskStatus>(['success', 'error', 'cancelled'])

type ClipboardMode = 'copy' | 'move'
type TransferTaskKind = ClipboardMode
type TransferTaskStatus = 'queued' | 'running' | 'success' | 'error' | 'cancelled'
type InlinePathActionType = 'createDirectory' | 'createFile' | 'renamePath'

interface InlinePathActionState {
  type: InlinePathActionType
  sourcePath?: string
  value: string
}

interface ClipboardPayload {
  mode: ClipboardMode
  sourceTerminalId: string
  sourcePaths: string[]
  itemNames: string[]
  sourceBasePath: string
  createdAt: number
}

interface TransferTaskState {
  id: string
  kind: TransferTaskKind
  sourceTerminalId: string
  targetTerminalId: string
  targetPath: string
  itemNames: string[]
  status: TransferTaskStatus
  bytesDone: number
  totalBytes: number
  transferredFiles: number
  totalFiles: number
  percent: number
  message: string | null
  errorMessage: string | null
  cancelRequested: boolean
  createdAt: number
  updatedAt: number
}

interface QueuedTransferTask {
  taskId: string
  run: () => Promise<void>
}

const toErrorMessage = (error: unknown): string => {
  if (error instanceof Error && typeof error.message === 'string' && error.message.trim().length > 0) {
    return error.message
  }
  if (typeof error === 'string' && error.trim().length > 0) {
    return error
  }
  return 'Operation failed.'
}

const isPathMissingError = (error: unknown): boolean => {
  const maybeError = error as { code?: unknown; message?: unknown } | null
  if (maybeError?.code === 'ENOENT' || maybeError?.code === 2 || maybeError?.code === '2') {
    return true
  }
  const message = typeof maybeError?.message === 'string'
    ? maybeError.message
    : error instanceof Error
      ? error.message
      : String(error || '')
  return /no such file|not found|cannot find/i.test(message)
}

const isTransferCancelledError = (error: unknown): boolean => {
  const maybeError = error as { code?: unknown; name?: unknown; message?: unknown } | null
  if (maybeError?.code === TRANSFER_CANCELLED_ERROR_CODE) {
    return true
  }
  if (maybeError?.name === 'AbortError') {
    return true
  }
  const message = typeof maybeError?.message === 'string'
    ? maybeError.message
    : error instanceof Error
      ? error.message
      : String(error || '')
  return /cancelled|canceled/i.test(message)
}

const formatFileSize = (size: number): string => {
  if (!Number.isFinite(size) || size <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = size
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  const digits = value >= 100 || unitIndex === 0 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(digits)} ${units[unitIndex]}`
}

const joinPath = (basePath: string, leafName: string): string => {
  const trimmedLeaf = leafName.trim()
  if (!trimmedLeaf) return basePath
  if (!basePath || basePath === '.') return trimmedLeaf
  if (basePath === '/') return `/${trimmedLeaf.replace(/^\/+/, '')}`
  return `${basePath.replace(/\/+$/, '')}/${trimmedLeaf.replace(/^\/+/, '')}`
}

const parentPath = (inputPath: string): string | null => {
  const normalized = inputPath.trim()
  if (!normalized || normalized === '.') return null
  if (normalized === '/' || /^[A-Za-z]:[\\/]?$/.test(normalized)) return null

  const withoutTail = normalized.replace(/[\\/]+$/, '')
  if (!withoutTail || withoutTail === '/' || /^[A-Za-z]:$/.test(withoutTail)) {
    return null
  }

  const slashIndex = Math.max(withoutTail.lastIndexOf('/'), withoutTail.lastIndexOf('\\'))
  if (slashIndex < 0) return '.'
  if (slashIndex === 0) {
    return withoutTail.startsWith('\\') ? '\\' : '/'
  }

  const parent = withoutTail.slice(0, slashIndex)
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}\\`
  return parent
}

const normalizePathForCompare = (inputPath: string): string => {
  const withForwardSlash = inputPath.replace(/\\/g, '/')
  const trimmed = withForwardSlash.replace(/\/+$/, '')
  return trimmed.length > 0 ? trimmed : '/'
}

const isSameOrDescendantPath = (candidatePath: string, rootPath: string): boolean => {
  const normalizedCandidate = normalizePathForCompare(candidatePath)
  const normalizedRoot = normalizePathForCompare(rootPath)
  if (normalizedCandidate === normalizedRoot) return true
  return normalizedCandidate.startsWith(`${normalizedRoot}/`)
}

export const FileSystemPanel: React.FC<FileSystemPanelProps> = observer(({
  store,
  panelId,
  tabs,
  activeTabId,
  onSelectTab,
  onLayoutHeaderMouseDown,
  onLayoutHeaderContextMenu
}) => {
  const t = store.i18n.t
  const [stateByTabId, setStateByTabId] = React.useState<Record<string, BrowserTabState>>({})
  const [inlinePathAction, setInlinePathAction] = React.useState<InlinePathActionState | null>(null)
  const [clipboard, setClipboard] = React.useState<ClipboardPayload | null>(null)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = React.useState(false)
  const [isDeleteConfirmLoading, setDeleteConfirmLoading] = React.useState(false)
  const [overwriteConfirmOpen, setOverwriteConfirmOpen] = React.useState(false)
  const [isOverwriteConfirmLoading, setOverwriteConfirmLoading] = React.useState(false)
  const pendingOverwriteRef = React.useRef<{
    clipboard: ClipboardPayload
    targetTerminalId: string
    targetPath: string
    conflictNames: string[]
  } | null>(null)
  const [transferTasks, setTransferTasks] = React.useState<Record<string, TransferTaskState>>({})
  const requestVersionRef = React.useRef<Record<string, number>>({})
  const transferTasksRef = React.useRef<Record<string, TransferTaskState>>({})
  const transferQueueRef = React.useRef<QueuedTransferTask[]>([])
  const runningTransferCountRef = React.useRef(0)
  const transferCancelHandlersRef = React.useRef<Record<string, () => void>>({})
  const transferCleanupTimersRef = React.useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const reloadDirectoryTimersRef = React.useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const transferPumpRef = React.useRef<() => void>(() => {})
  const inlineActionInputRef = React.useRef<HTMLInputElement | null>(null)

  React.useEffect(() => {
    transferTasksRef.current = transferTasks
  }, [transferTasks])

  React.useEffect(() => {
    if (tabs.length <= 0) return
    const activeExists = !!activeTabId && tabs.some((tab) => tab.id === activeTabId)
    if (!activeExists) {
      onSelectTab(tabs[0].id)
    }
  }, [activeTabId, onSelectTab, tabs])

  const updateTabState = React.useCallback(
    (tabId: string, updater: (current: BrowserTabState) => BrowserTabState): void => {
      setStateByTabId((previous) => {
        const current = previous[tabId] || createInitialTabState()
        const next = updater(current)
        if (next === current) return previous
        return {
          ...previous,
          [tabId]: next
        }
      })
    },
    []
  )

  const updateTransferTask = React.useCallback(
    (taskId: string, updater: (current: TransferTaskState) => TransferTaskState): void => {
      setTransferTasks((previous) => {
        const current = previous[taskId]
        if (!current) return previous
        const next = updater(current)
        if (next === current) return previous
        const nextState = {
          ...previous,
          [taskId]: next
        }
        transferTasksRef.current = nextState
        return nextState
      })
    },
    []
  )

  const removeTransferTask = React.useCallback((taskId: string): void => {
    const timer = transferCleanupTimersRef.current[taskId]
    if (timer) {
      clearTimeout(timer)
      delete transferCleanupTimersRef.current[taskId]
    }
    setTransferTasks((previous) => {
      if (!previous[taskId]) return previous
      const next = { ...previous }
      delete next[taskId]
      transferTasksRef.current = next
      return next
    })
  }, [])

  const scheduleTransferCleanup = React.useCallback((taskId: string, delayMs = 7000): void => {
    const prevTimer = transferCleanupTimersRef.current[taskId]
    if (prevTimer) {
      clearTimeout(prevTimer)
    }
    transferCleanupTimersRef.current[taskId] = setTimeout(() => {
      removeTransferTask(taskId)
    }, delayMs)
  }, [removeTransferTask])

  React.useEffect(() => {
    return () => {
      Object.values(transferCleanupTimersRef.current).forEach((timer) => {
        clearTimeout(timer)
      })
      Object.values(reloadDirectoryTimersRef.current).forEach((timer) => {
        clearTimeout(timer)
      })
      Object.values(transferCancelHandlersRef.current).forEach((cancel) => {
        try {
          cancel()
        } catch {
          // ignore
        }
      })
    }
  }, [])

  const loadDirectory = React.useCallback(
    async (terminalId: string, dirPath?: string): Promise<void> => {
      const requestVersion = (requestVersionRef.current[terminalId] || 0) + 1
      requestVersionRef.current[terminalId] = requestVersion
      updateTabState(terminalId, (current) => ({
        ...current,
        hasBootstrapped: true,
        loading: true,
        errorMessage: null,
        statusMessage: null
      }))
      try {
        const result = await window.gyshell.filesystem.list(terminalId, dirPath)
        if (requestVersionRef.current[terminalId] !== requestVersion) return
        updateTabState(terminalId, (current) => {
          const selectedPaths = current.selectedPaths.filter((path) => result.entries.some((entry) => entry.path === path))
          const selectionAnchorPath = current.selectionAnchorPath && selectedPaths.includes(current.selectionAnchorPath)
            ? current.selectionAnchorPath
            : selectedPaths[0] || null
          return {
            ...current,
            hasBootstrapped: true,
            currentPath: result.path,
            pathInput: result.path,
            entries: result.entries,
            loading: false,
            errorMessage: null,
            selectedPaths,
            selectionAnchorPath
          }
        })
      } catch (error) {
        if (requestVersionRef.current[terminalId] !== requestVersion) return
        updateTabState(terminalId, (current) => ({
          ...current,
          hasBootstrapped: true,
          loading: false,
          errorMessage: toErrorMessage(error)
        }))
      }
    },
    [updateTabState]
  )

  const scheduleDirectoryReload = React.useCallback((terminalId: string, reloadPath: string): void => {
    const prevTimer = reloadDirectoryTimersRef.current[terminalId]
    if (prevTimer) {
      clearTimeout(prevTimer)
    }
    reloadDirectoryTimersRef.current[terminalId] = setTimeout(() => {
      delete reloadDirectoryTimersRef.current[terminalId]
      void loadDirectory(terminalId, reloadPath)
    }, 260)
  }, [loadDirectory])

  const activeTabStateForBootstrap = activeTabId ? stateByTabId[activeTabId] : undefined
  const activeTabLoading = activeTabStateForBootstrap?.loading === true
  const activeTabBootstrapped = activeTabStateForBootstrap?.hasBootstrapped === true

  React.useEffect(() => {
    if (!activeTabId) return
    const targetTab = tabs.find((tab) => tab.id === activeTabId) || null
    if (!targetTab) return
    if (targetTab.runtimeState === 'initializing') return
    if (activeTabLoading) return
    if (activeTabBootstrapped) return
    void loadDirectory(activeTabId)
  }, [activeTabBootstrapped, activeTabId, activeTabLoading, loadDirectory, tabs])

  const activeTab = tabs.find((tab) => tab.id === activeTabId) || tabs[0] || null
  const activeTerminalId = activeTab?.id || null
  const activeState = activeTerminalId ? (stateByTabId[activeTerminalId] || createInitialTabState()) : createInitialTabState()
  const selectedEntries = React.useMemo(
    () => activeState.entries.filter((entry) => activeState.selectedPaths.includes(entry.path)),
    [activeState.entries, activeState.selectedPaths]
  )
  const singleSelectedEntry = selectedEntries.length === 1 ? selectedEntries[0] : null
  const selectedCount = selectedEntries.length

  React.useEffect(() => {
    setInlinePathAction(null)
    setDeleteConfirmOpen(false)
    setDeleteConfirmLoading(false)
    setOverwriteConfirmOpen(false)
    setOverwriteConfirmLoading(false)
    pendingOverwriteRef.current = null
  }, [activeTerminalId])

  const inlineActionSessionKey = React.useMemo(() => {
    if (!inlinePathAction) return null
    return `${inlinePathAction.type}:${inlinePathAction.sourcePath || ''}`
  }, [inlinePathAction?.sourcePath, inlinePathAction?.type])

  React.useEffect(() => {
    if (!inlinePathAction || !inlineActionInputRef.current) return
    inlineActionInputRef.current.focus()
    inlineActionInputRef.current.select()
  }, [inlineActionSessionKey])

  const getTransferStatusLabel = React.useCallback((status: TransferTaskStatus): string => {
    if (status === 'queued') return t.filesystem.transferQueued
    if (status === 'running') return t.filesystem.transferRunning
    if (status === 'success') return t.filesystem.transferCompleted
    if (status === 'cancelled') return t.filesystem.transferCancelled
    return t.filesystem.transferFailed
  }, [t.filesystem])

  transferPumpRef.current = () => {
    while (runningTransferCountRef.current < TRANSFER_CONCURRENCY_LIMIT && transferQueueRef.current.length > 0) {
      const nextTask = transferQueueRef.current.shift()
      if (!nextTask) break
      const taskSnapshot = transferTasksRef.current[nextTask.taskId]
      if (!taskSnapshot || taskSnapshot.status !== 'queued') {
        continue
      }
      runningTransferCountRef.current += 1
      updateTransferTask(nextTask.taskId, (current) => ({
        ...current,
        status: 'running',
        message: current.cancelRequested ? t.filesystem.transferCancelling : current.message,
        updatedAt: Date.now()
      }))
      void nextTask.run().catch((error) => {
        const cancelled = isTransferCancelledError(error)
        const fallbackMessage = cancelled ? t.filesystem.transferCancelled : toErrorMessage(error)
        updateTransferTask(nextTask.taskId, (current) => {
          if (!current || TERMINAL_TRANSFER_STATUSES.has(current.status)) {
            return current
          }
          return {
            ...current,
            status: cancelled ? 'cancelled' : 'error',
            message: fallbackMessage,
            errorMessage: cancelled ? null : fallbackMessage,
            cancelRequested: cancelled || current.cancelRequested,
            updatedAt: Date.now()
          }
        })
        scheduleTransferCleanup(nextTask.taskId)
      }).finally(() => {
        delete transferCancelHandlersRef.current[nextTask.taskId]
        runningTransferCountRef.current = Math.max(0, runningTransferCountRef.current - 1)
        transferPumpRef.current()
      })
    }
  }

  const enqueueTransferTask = React.useCallback((
    task: Omit<TransferTaskState, 'id' | 'status' | 'bytesDone' | 'percent' | 'transferredFiles' | 'totalFiles' | 'createdAt' | 'updatedAt' | 'errorMessage' | 'cancelRequested'>,
    runner: (taskId: string) => Promise<void>
  ): string => {
    const taskId = `fs-transfer:${task.kind}:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`
    const now = Date.now()
    const nextTask: TransferTaskState = {
      id: taskId,
      kind: task.kind,
      sourceTerminalId: task.sourceTerminalId,
      targetTerminalId: task.targetTerminalId,
      targetPath: task.targetPath,
      itemNames: task.itemNames,
      status: 'queued',
      bytesDone: 0,
      totalBytes: 0,
      transferredFiles: 0,
      totalFiles: 0,
      percent: 0,
      message: task.message,
      errorMessage: null,
      cancelRequested: false,
      createdAt: now,
      updatedAt: now
    }
    transferTasksRef.current = {
      ...transferTasksRef.current,
      [taskId]: nextTask
    }
    setTransferTasks((previous) => ({
      ...previous,
      [taskId]: nextTask
    }))
    transferQueueRef.current.push({
      taskId,
      run: () => runner(taskId)
    })
    transferPumpRef.current()
    return taskId
  }, [])

  const cancelTransferTask = React.useCallback((taskId: string): void => {
    const current = transferTasksRef.current[taskId]
    if (!current || TERMINAL_TRANSFER_STATUSES.has(current.status)) {
      return
    }

    if (current.status === 'queued') {
      transferQueueRef.current = transferQueueRef.current.filter((item) => item.taskId !== taskId)
      updateTransferTask(taskId, (task) => ({
        ...task,
        status: 'cancelled',
        message: t.filesystem.transferCancelled,
        cancelRequested: true,
        updatedAt: Date.now()
      }))
      scheduleTransferCleanup(taskId)
      return
    }

    updateTransferTask(taskId, (task) => ({
      ...task,
      cancelRequested: true,
      message: t.filesystem.transferCancelling,
      updatedAt: Date.now()
    }))
    const cancel = transferCancelHandlersRef.current[taskId]
    if (cancel) {
      try {
        cancel()
      } catch {
        // ignore cancellation errors
      }
    }
  }, [
    scheduleTransferCleanup,
    t.filesystem.transferCancelled,
    t.filesystem.transferCancelling,
    updateTransferTask
  ])

  const runBusyOperation = React.useCallback(
    async (
      terminalId: string,
      operation: () => Promise<void>,
      options?: { successMessage?: string; reloadPath?: string }
    ): Promise<void> => {
      updateTabState(terminalId, (current) => ({ ...current, busy: true, statusMessage: null, errorMessage: null }))
      try {
        await operation()
        if (options?.reloadPath !== undefined) {
          await loadDirectory(terminalId, options.reloadPath)
        }
        updateTabState(terminalId, (current) => ({
          ...current,
          busy: false,
          statusMessage: options?.successMessage || null
        }))
      } catch (error) {
        updateTabState(terminalId, (current) => ({
          ...current,
          busy: false,
          errorMessage: toErrorMessage(error)
        }))
      }
    },
    [loadDirectory, updateTabState]
  )

  const handleSelectEntry = React.useCallback(
    (event: React.MouseEvent<HTMLElement>, entry: FileSystemEntry): void => {
      if (!activeTerminalId) return
      updateTabState(activeTerminalId, (current) => {
        const paths = current.entries.map((item) => item.path)
        const currentSelection = new Set(current.selectedPaths)
        let nextSelectedPaths: string[] = []
        let nextAnchorPath = current.selectionAnchorPath

        if (event.shiftKey && current.selectionAnchorPath && paths.includes(current.selectionAnchorPath)) {
          const startIndex = paths.indexOf(current.selectionAnchorPath)
          const endIndex = paths.indexOf(entry.path)
          if (startIndex >= 0 && endIndex >= 0) {
            const [from, to] = startIndex <= endIndex ? [startIndex, endIndex] : [endIndex, startIndex]
            nextSelectedPaths = paths.slice(from, to + 1)
            nextAnchorPath = current.selectionAnchorPath
          }
        } else if (event.metaKey || event.ctrlKey) {
          if (currentSelection.has(entry.path)) {
            currentSelection.delete(entry.path)
          } else {
            currentSelection.add(entry.path)
          }
          nextSelectedPaths = paths.filter((itemPath) => currentSelection.has(itemPath))
          nextAnchorPath = entry.path
        } else {
          nextSelectedPaths = [entry.path]
          nextAnchorPath = entry.path
        }

        if (nextSelectedPaths.length === 0) {
          nextAnchorPath = null
        }

        return {
          ...current,
          selectedPaths: nextSelectedPaths,
          selectionAnchorPath: nextAnchorPath,
          statusMessage: null
        }
      })
    },
    [activeTerminalId, updateTabState]
  )

  const navigateDirectory = React.useCallback(
    (targetPath?: string): void => {
      if (!activeTerminalId) return
      const path = typeof targetPath === 'string' && targetPath.trim().length > 0 ? targetPath.trim() : undefined
      void loadDirectory(activeTerminalId, path)
    },
    [activeTerminalId, loadDirectory]
  )

  const handleOpenParent = React.useCallback(() => {
    if (!activeTerminalId || !activeState.currentPath) return
    const nextPath = parentPath(activeState.currentPath)
    if (!nextPath) return
    void loadDirectory(activeTerminalId, nextPath)
  }, [activeState.currentPath, activeTerminalId, loadDirectory])

  const handleCreateDirectory = React.useCallback(() => {
    if (!activeTerminalId) return
    setInlinePathAction({
      type: 'createDirectory',
      value: ''
    })
  }, [activeTerminalId])

  const handleCreateFile = React.useCallback(() => {
    if (!activeTerminalId) return
    setInlinePathAction({
      type: 'createFile',
      value: ''
    })
  }, [activeTerminalId])

  const handleRename = React.useCallback(() => {
    if (!activeTerminalId || !singleSelectedEntry) return
    setInlinePathAction({
      type: 'renamePath',
      sourcePath: singleSelectedEntry.path,
      value: singleSelectedEntry.name
    })
  }, [activeTerminalId, singleSelectedEntry])

  const cancelInlinePathAction = React.useCallback(() => {
    setInlinePathAction(null)
  }, [])

  const applyInlinePathAction = React.useCallback(() => {
    if (!activeTerminalId || !inlinePathAction) return
    const trimmedName = inlinePathAction.value.trim()
    if (!trimmedName) {
      updateTabState(activeTerminalId, (current) => ({
        ...current,
        errorMessage: t.filesystem.nameRequired
      }))
      return
    }
    if (/[\\/]/.test(trimmedName)) {
      updateTabState(activeTerminalId, (current) => ({
        ...current,
        errorMessage: t.filesystem.invalidNameCharacters
      }))
      return
    }

    if (inlinePathAction.type === 'createDirectory') {
      const targetPath = joinPath(activeState.currentPath || '.', trimmedName)
      setInlinePathAction(null)
      void runBusyOperation(
        activeTerminalId,
        async () => {
          await window.gyshell.filesystem.createDirectory(activeTerminalId, targetPath)
        },
        {
          successMessage: t.filesystem.directoryCreated,
          reloadPath: activeState.currentPath
        }
      )
      return
    }

    if (inlinePathAction.type === 'createFile') {
      const targetPath = joinPath(activeState.currentPath || '.', trimmedName)
      setInlinePathAction(null)
      void runBusyOperation(
        activeTerminalId,
        async () => {
          await window.gyshell.filesystem.createFile(activeTerminalId, targetPath)
        },
        {
          successMessage: t.filesystem.fileCreated,
          reloadPath: activeState.currentPath
        }
      )
      return
    }

    const sourcePath = inlinePathAction.sourcePath
    if (!sourcePath) {
      setInlinePathAction(null)
      return
    }
    const basePath = parentPath(sourcePath) || activeState.currentPath || '.'
    const targetPath = joinPath(basePath, trimmedName)
    setInlinePathAction(null)
    if (targetPath === sourcePath) {
      return
    }
    void runBusyOperation(
      activeTerminalId,
      async () => {
        await window.gyshell.filesystem.renamePath(activeTerminalId, sourcePath, targetPath)
      },
      {
        successMessage: t.filesystem.pathRenamed,
        reloadPath: activeState.currentPath
      }
    )
  }, [
    activeState.currentPath,
    activeTerminalId,
    inlinePathAction,
    runBusyOperation,
    t.filesystem,
    updateTabState
  ])

  const deleteRootEntries = React.useMemo(() => {
    const sorted = selectedEntries.slice().sort((left, right) => left.path.length - right.path.length)
    return sorted.filter((entry, index) => {
      for (let i = 0; i < index; i += 1) {
        const ancestor = sorted[i]
        if (!ancestor.isDirectory) continue
        if (isSameOrDescendantPath(entry.path, ancestor.path)) {
          return false
        }
      }
      return true
    })
  }, [selectedEntries])

  const handleDelete = React.useCallback(() => {
    if (!activeTerminalId || deleteRootEntries.length <= 0) return
    setDeleteConfirmOpen(true)
  }, [activeTerminalId, deleteRootEntries.length])

  const confirmDeleteSelected = React.useCallback(async (): Promise<void> => {
    if (!activeTerminalId || deleteRootEntries.length <= 0) return
    setDeleteConfirmLoading(true)
    updateTabState(activeTerminalId, (current) => ({
      ...current,
      busy: true,
      statusMessage: null,
      errorMessage: null
    }))
    try {
      for (const entry of deleteRootEntries) {
        await window.gyshell.filesystem.deletePath(activeTerminalId, entry.path, {
          recursive: entry.isDirectory
        }).catch((error) => {
          if (isPathMissingError(error)) return
          throw error
        })
      }
      const reloadPath = activeState.currentPath
      if (reloadPath) {
        await loadDirectory(activeTerminalId, reloadPath)
      } else {
        await loadDirectory(activeTerminalId)
      }
      updateTabState(activeTerminalId, (current) => ({
        ...current,
        busy: false,
        statusMessage: t.filesystem.pathDeleted,
        selectedPaths: [],
        selectionAnchorPath: null
      }))
      setDeleteConfirmOpen(false)
    } catch (error) {
      updateTabState(activeTerminalId, (current) => ({
        ...current,
        busy: false,
        errorMessage: toErrorMessage(error)
      }))
    } finally {
      setDeleteConfirmLoading(false)
    }
  }, [
    activeState.currentPath,
    activeTerminalId,
    deleteRootEntries,
    loadDirectory,
    t.filesystem.pathDeleted,
    updateTabState
  ])

  const setClipboardFromSelection = React.useCallback((mode: ClipboardMode): void => {
    if (!activeTerminalId || selectedEntries.length <= 0) return
    const nextClipboard: ClipboardPayload = {
      mode,
      sourceTerminalId: activeTerminalId,
      sourcePaths: selectedEntries.map((entry) => entry.path),
      itemNames: selectedEntries.map((entry) => entry.name),
      sourceBasePath: activeState.currentPath || '.',
      createdAt: Date.now()
    }
    setClipboard(nextClipboard)
    updateTabState(activeTerminalId, (current) => ({
      ...current,
      statusMessage: mode === 'copy'
        ? t.filesystem.copiedItemsToClipboard(selectedEntries.length)
        : t.filesystem.cutItemsToClipboard(selectedEntries.length),
      errorMessage: null
    }))
  }, [activeState.currentPath, activeTerminalId, selectedEntries, t.filesystem, updateTabState])

  const queueClipboardTransfer = React.useCallback((
    clipboardPayload: ClipboardPayload,
    targetTerminalId: string,
    targetPath: string,
    overwrite: boolean
  ): void => {
    const mode = clipboardPayload.mode
    const kind: TransferTaskKind = mode
    const statusMessage = mode === 'move'
      ? t.filesystem.movingItems(clipboardPayload.itemNames.length)
      : t.filesystem.copyingItems(clipboardPayload.itemNames.length)

    updateTabState(targetTerminalId, (current) => ({
      ...current,
      statusMessage,
      errorMessage: null
    }))

    enqueueTransferTask(
      {
        kind,
        sourceTerminalId: clipboardPayload.sourceTerminalId,
        targetTerminalId,
        targetPath,
        itemNames: clipboardPayload.itemNames,
        totalBytes: 0,
        message: t.filesystem.transferQueued
      },
      async (taskId) => {
        const transferId = `filesystem-transfer:${taskId}`
        let lastReportedPercent = -1
        let lastStatusUpdateAt = 0
        transferCancelHandlersRef.current[taskId] = () => {
          void window.gyshell.filesystem.cancelTransfer(transferId).catch(() => {
            // ignore cancellation ipc errors
          })
        }
        if (transferTasksRef.current[taskId]?.cancelRequested) {
          transferCancelHandlersRef.current[taskId]?.()
        }
        const removeProgressListener = window.gyshell.filesystem.onTransferProgress((payload) => {
          if (payload.transferId !== transferId) return
          const percent = payload.totalBytes > 0
            ? Math.min(100, Math.round((payload.bytesTransferred / payload.totalBytes) * 100))
            : payload.eof
              ? 100
              : 0
          const now = Date.now()
          const shouldReportProgress = percent >= 100
            || percent - lastReportedPercent >= STATUS_UPDATE_MIN_PERCENT_STEP
            || now - lastStatusUpdateAt >= STATUS_UPDATE_MIN_INTERVAL_MS
          if (!shouldReportProgress) return
          lastReportedPercent = percent
          lastStatusUpdateAt = now
          updateTransferTask(taskId, (current) => ({
            ...current,
            bytesDone: payload.bytesTransferred,
            totalBytes: payload.totalBytes,
            transferredFiles: payload.transferredFiles,
            totalFiles: payload.totalFiles,
            percent,
            message: current.status === 'running'
              ? t.filesystem.transferringItemsProgress(percent)
              : current.message,
            updatedAt: current.status === 'running' ? now : current.updatedAt
          }))
        })

        try {
          const result = await window.gyshell.filesystem.transferEntries(
            clipboardPayload.sourceTerminalId,
            clipboardPayload.sourcePaths,
            targetTerminalId,
            targetPath,
            {
              mode,
              transferId,
              overwrite
            }
          )
          const successMessage = mode === 'move'
            ? t.filesystem.filesMoved(result.transferredFiles)
            : t.filesystem.filesCopied(result.transferredFiles)
          updateTransferTask(taskId, (current) => ({
            ...current,
            status: 'success',
            bytesDone: result.totalBytes,
            totalBytes: result.totalBytes,
            transferredFiles: result.transferredFiles,
            totalFiles: result.totalFiles,
            percent: 100,
            message: successMessage,
            updatedAt: Date.now()
          }))
          updateTabState(targetTerminalId, (current) => ({
            ...current,
            statusMessage: successMessage
          }))
          scheduleDirectoryReload(targetTerminalId, targetPath)
          if (mode === 'move') {
            scheduleDirectoryReload(clipboardPayload.sourceTerminalId, clipboardPayload.sourceBasePath)
            setClipboard(null)
          }
          scheduleTransferCleanup(taskId)
        } catch (error) {
          if (isTransferCancelledError(error)) {
            updateTransferTask(taskId, (current) => ({
              ...current,
              status: 'cancelled',
              cancelRequested: true,
              message: t.filesystem.transferCancelled,
              errorMessage: null,
              updatedAt: Date.now()
            }))
            updateTabState(targetTerminalId, (current) => ({
              ...current,
              statusMessage: t.filesystem.transferCancelled
            }))
          } else {
            const message = toErrorMessage(error)
            updateTransferTask(taskId, (current) => ({
              ...current,
              status: 'error',
              message,
              errorMessage: message,
              updatedAt: Date.now()
            }))
            updateTabState(targetTerminalId, (current) => ({
              ...current,
              errorMessage: message
            }))
          }
          scheduleTransferCleanup(taskId)
        } finally {
          removeProgressListener()
        }
      }
    )
  }, [
    enqueueTransferTask,
    scheduleDirectoryReload,
    scheduleTransferCleanup,
    t.filesystem,
    updateTabState,
    updateTransferTask
  ])

  const handlePasteClipboard = React.useCallback((forceOverwrite = false): void => {
    if (!clipboard || !activeTerminalId) return
    const targetPath = activeState.currentPath || '.'
    const existingNameSet = new Set(activeState.entries.map((entry) => entry.name))
    const conflictNames = clipboard.itemNames.filter((name) => existingNameSet.has(name))

    if (!forceOverwrite && conflictNames.length > 0) {
      pendingOverwriteRef.current = {
        clipboard,
        targetTerminalId: activeTerminalId,
        targetPath,
        conflictNames
      }
      setOverwriteConfirmOpen(true)
      return
    }

    queueClipboardTransfer(clipboard, activeTerminalId, targetPath, forceOverwrite)
  }, [activeState.currentPath, activeState.entries, activeTerminalId, clipboard, queueClipboardTransfer])

  const confirmOverwriteAndPaste = React.useCallback(async (): Promise<void> => {
    const pending = pendingOverwriteRef.current
    if (!pending) return
    setOverwriteConfirmLoading(true)
    try {
      queueClipboardTransfer(pending.clipboard, pending.targetTerminalId, pending.targetPath, true)
      setOverwriteConfirmOpen(false)
      pendingOverwriteRef.current = null
    } finally {
      setOverwriteConfirmLoading(false)
    }
  }, [queueClipboardTransfer])

  const clearClipboard = React.useCallback((): void => {
    pendingOverwriteRef.current = null
    setOverwriteConfirmOpen(false)
    setClipboard(null)
  }, [])

  const handlePanelKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLElement>): void => {
    const target = event.target as HTMLElement | null
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
      return
    }
    if (!clipboard) return
    const isPasteShortcut = (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'v'
    if (!isPasteShortcut) return
    event.preventDefault()
    handlePasteClipboard()
  }, [clipboard, handlePasteClipboard])

  const isLayoutDragSource = store.layout.isDragging && store.layout.draggingPanelId === panelId
  const terminalFontSize = React.useMemo(() => {
    const raw = store.settings?.terminal?.fontSize
    if (!Number.isFinite(raw)) return 14
    return Math.max(10, Math.min(28, Math.floor(raw as number)))
  }, [store.settings?.terminal?.fontSize])
  const filesystemPanelStyle = React.useMemo(
    () => ({ '--filesystem-font-size': `${terminalFontSize}px` } as React.CSSProperties),
    [terminalFontSize]
  )
  const transferTaskList = React.useMemo(() => {
    return Object.values(transferTasks)
      .filter((task) => task.targetTerminalId === activeTerminalId || task.sourceTerminalId === activeTerminalId)
      .sort((left, right) => right.updatedAt - left.updatedAt)
  }, [activeTerminalId, transferTasks])
  const inlineActionLabel = React.useMemo(() => {
    if (!inlinePathAction) return ''
    if (inlinePathAction.type === 'createDirectory') return t.filesystem.createDirectory
    if (inlinePathAction.type === 'createFile') return t.filesystem.createFile
    return t.filesystem.renamePath
  }, [inlinePathAction, t.filesystem.createDirectory, t.filesystem.createFile, t.filesystem.renamePath])
  const inlineActionPlaceholder = React.useMemo(() => {
    if (!inlinePathAction) return ''
    if (inlinePathAction.type === 'createDirectory') return t.filesystem.promptDirectoryName
    if (inlinePathAction.type === 'createFile') return t.filesystem.promptFileName
    return t.filesystem.promptRename
  }, [inlinePathAction, t.filesystem.promptDirectoryName, t.filesystem.promptFileName, t.filesystem.promptRename])

  const clipboardHint = React.useMemo(() => {
    if (!clipboard) return null
    return clipboard.mode === 'move'
      ? t.filesystem.clipboardReadyToPasteMove(clipboard.itemNames.length)
      : t.filesystem.clipboardReadyToPasteCopy(clipboard.itemNames.length)
  }, [clipboard, t.filesystem])
  const deleteConfirmMessage = React.useMemo(() => {
    if (deleteRootEntries.length <= 0) return ''
    if (deleteRootEntries.length === 1) {
      return t.filesystem.confirmDelete(deleteRootEntries[0].name)
    }
    return t.filesystem.confirmDeleteMany(deleteRootEntries.length)
  }, [deleteRootEntries, t.filesystem])
  const overwriteConflictPreview = React.useMemo(() => {
    const pending = pendingOverwriteRef.current
    if (!pending || pending.conflictNames.length <= 0) return ''
    const previewNames = pending.conflictNames.slice(0, 4).join(', ')
    if (pending.conflictNames.length <= 4) return previewNames
    return `${previewNames} ...`
  }, [overwriteConfirmOpen])

  if (tabs.length === 0) {
    return (
      <div className={`panel panel-filesystem${isLayoutDragSource ? ' is-dragging-source' : ''}`} style={filesystemPanelStyle}>
        <div
          className="filesystem-tabs-container is-draggable"
          onMouseDown={onLayoutHeaderMouseDown}
          onContextMenu={onLayoutHeaderContextMenu}
        >
          <div className="panel-tab-drag-handle" aria-hidden="true">
            <GripVertical size={12} strokeWidth={2.4} />
          </div>
          <div className="filesystem-tabs-bar" />
        </div>
        <div className="panel-body filesystem-panel-body">
          <div className="filesystem-empty-state">{t.filesystem.noTerminalTabs}</div>
        </div>
      </div>
    )
  }

  const isBusy = activeState.loading || activeState.busy

  return (
    <div
      className={`panel panel-filesystem${isLayoutDragSource ? ' is-dragging-source' : ''}`}
      style={filesystemPanelStyle}
      tabIndex={0}
      onKeyDown={handlePanelKeyDown}
    >
      <ConfirmDialog
        open={deleteConfirmOpen}
        title={t.common.confirmDeleteTitle}
        message={deleteConfirmMessage}
        confirmText={t.common.delete}
        cancelText={t.common.cancel}
        danger
        loading={isDeleteConfirmLoading}
        onCancel={() => {
          if (isDeleteConfirmLoading) return
          setDeleteConfirmOpen(false)
        }}
        onConfirm={() => {
          void confirmDeleteSelected()
        }}
      />
      <ConfirmDialog
        open={overwriteConfirmOpen}
        title={t.filesystem.pasteConflictTitle}
        message={t.filesystem.pasteConflictMessage(
          pendingOverwriteRef.current?.conflictNames.length || 0,
          overwriteConflictPreview
        )}
        confirmText={t.filesystem.overwriteAndPaste}
        cancelText={t.common.cancel}
        danger
        loading={isOverwriteConfirmLoading}
        onCancel={() => {
          if (isOverwriteConfirmLoading) return
          setOverwriteConfirmOpen(false)
          pendingOverwriteRef.current = null
        }}
        onConfirm={() => {
          void confirmOverwriteAndPaste()
        }}
      />
      <div
        className="filesystem-tabs-container is-draggable"
        onMouseDown={onLayoutHeaderMouseDown}
        onContextMenu={onLayoutHeaderContextMenu}
      >
        <div className="panel-tab-drag-handle" aria-hidden="true">
          <GripVertical size={12} strokeWidth={2.4} />
        </div>
        <div
          className="filesystem-tabs-bar"
          data-layout-tab-bar="true"
          data-layout-tab-panel-id={panelId}
          data-layout-tab-kind="filesystem"
        >
          {tabs.map((tab, index) => {
            const isActive = tab.id === activeTerminalId
            const runtimeState = tab.runtimeState || 'initializing'
            const runtimeIndicatorState = runtimeState === 'ready' ? 'ready' : 'inactive'
            return (
              <div
                key={tab.id}
                className={isActive ? 'filesystem-tab is-active' : 'filesystem-tab'}
                onClick={() => onSelectTab(tab.id)}
                role="button"
                tabIndex={0}
                draggable
                data-layout-tab-draggable="true"
                data-layout-tab-id={tab.id}
                data-layout-tab-kind="filesystem"
                data-layout-tab-panel-id={panelId}
                data-layout-tab-index={index}
              >
                <span className="filesystem-tab-icon">
                  <Folder size={14} strokeWidth={2} />
                </span>
                <span className="filesystem-tab-title">{tab.title}</span>
                <span className={`tab-runtime-state tab-runtime-state-${runtimeIndicatorState}`} title={runtimeState} />
              </div>
            )
          })}
        </div>
      </div>

      <div className="filesystem-toolbar">
        <button
          className="icon-btn-sm"
          title={t.filesystem.openParent}
          onClick={handleOpenParent}
          disabled={isBusy || !activeState.currentPath || activeState.currentPath === '/'}
        >
          <ArrowUp size={14} strokeWidth={2} />
        </button>
        <button className="icon-btn-sm" title={t.common.refresh} onClick={() => navigateDirectory(activeState.currentPath)} disabled={isBusy}>
          <RefreshCw size={14} strokeWidth={2} />
        </button>
        <input
          className="filesystem-path-input"
          value={activeState.pathInput}
          onChange={(event) => {
            if (!activeTerminalId) return
            const value = event.target.value
            updateTabState(activeTerminalId, (current) => ({
              ...current,
              pathInput: value
            }))
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            navigateDirectory(activeState.pathInput)
          }}
          placeholder={t.filesystem.pathPlaceholder}
          disabled={isBusy}
        />
        <button className="icon-btn-sm" title={t.filesystem.createDirectory} onClick={handleCreateDirectory} disabled={isBusy}>
          <FolderPlus size={14} strokeWidth={2} />
        </button>
        <button className="icon-btn-sm" title={t.filesystem.createFile} onClick={handleCreateFile} disabled={isBusy}>
          <FileText size={14} strokeWidth={2} />
        </button>
        <button className="icon-btn-sm" title={t.filesystem.renamePath} onClick={handleRename} disabled={isBusy || !singleSelectedEntry}>
          <Pencil size={14} strokeWidth={2} />
        </button>
        <button className="icon-btn-sm danger" title={t.common.delete} onClick={handleDelete} disabled={isBusy || selectedCount <= 0}>
          <Trash2 size={14} strokeWidth={2} />
        </button>
        {clipboard ? (
          <>
            <button className="icon-btn-sm primary" title={t.filesystem.pastePath} onClick={() => handlePasteClipboard()} disabled={isBusy}>
              <Check size={14} strokeWidth={2.2} />
            </button>
            <button className="icon-btn-sm" title={t.filesystem.cancelClipboard} onClick={clearClipboard} disabled={isBusy}>
              <X size={14} strokeWidth={2.2} />
            </button>
          </>
        ) : (
          <>
            <button className="icon-btn-sm" title={t.filesystem.copyPath} onClick={() => setClipboardFromSelection('copy')} disabled={isBusy || selectedCount <= 0}>
              <Copy size={14} strokeWidth={2} />
            </button>
            <button className="icon-btn-sm" title={t.filesystem.cutPath} onClick={() => setClipboardFromSelection('move')} disabled={isBusy || selectedCount <= 0}>
              <Scissors size={14} strokeWidth={2} />
            </button>
          </>
        )}
      </div>

      {inlinePathAction ? (
        <div className="filesystem-inline-action-bar">
          <span className="filesystem-inline-action-label">{inlineActionLabel}</span>
          <input
            ref={inlineActionInputRef}
            className="filesystem-inline-action-input"
            value={inlinePathAction.value}
            onChange={(event) => {
              const value = event.target.value
              setInlinePathAction((current) => (current ? { ...current, value } : current))
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                applyInlinePathAction()
                return
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                cancelInlinePathAction()
              }
            }}
            placeholder={inlineActionPlaceholder}
          />
          <button
            className="icon-btn-sm primary"
            type="button"
            title={t.common.create}
            onClick={applyInlinePathAction}
          >
            <Check size={14} strokeWidth={2.4} />
          </button>
          <button
            className="icon-btn-sm"
            type="button"
            title={t.common.cancel}
            onClick={cancelInlinePathAction}
          >
            <X size={14} strokeWidth={2.4} />
          </button>
        </div>
      ) : null}

      <div className="filesystem-status-bar">
        {activeState.errorMessage ? (
          <span className="filesystem-status-error">{activeState.errorMessage}</span>
        ) : activeState.statusMessage ? (
          <span className="filesystem-status-message">{activeState.statusMessage}</span>
        ) : activeState.loading ? (
          <span className="filesystem-status-message">{t.filesystem.loadingDirectory}</span>
        ) : clipboardHint ? (
          <span className="filesystem-status-message">{clipboardHint}</span>
        ) : (
          <span className="filesystem-status-placeholder" />
        )}
      </div>

      <div className="panel-body filesystem-panel-body">
        <div className="filesystem-explorer">
          <div className="filesystem-list">
            {activeState.entries.length === 0 && !activeState.loading ? (
              <div className="filesystem-empty-state">{t.filesystem.emptyDirectory}</div>
            ) : (
              activeState.entries.map((entry) => {
                const isSelected = activeState.selectedPaths.includes(entry.path)
                const Icon = entry.isDirectory ? Folder : File
                return (
                  <div
                    key={entry.path}
                    className={isSelected ? 'filesystem-row is-selected' : 'filesystem-row'}
                    onClick={(event) => handleSelectEntry(event, entry)}
                    onDoubleClick={() => {
                      if (entry.isDirectory) {
                        navigateDirectory(entry.path)
                        return
                      }
                      if (!activeTerminalId) return
                      const previewSupport = resolveTextPreviewSupport(entry)
                      if (!previewSupport.supported) {
                        updateTabState(activeTerminalId, (current) => ({
                          ...current,
                          statusMessage: previewSupport.reason === 'fileTooLarge'
                            ? t.filesystem.previewTooLarge(entry.name, Math.floor(TEXT_PREVIEW_MAX_BYTES / (1024 * 1024)))
                            : t.filesystem.previewUnsupportedType(entry.name),
                          errorMessage: null
                        }))
                        return
                      }
                      void (async () => {
                        updateTabState(activeTerminalId, (current) => ({
                          ...current,
                          statusMessage: t.filesystem.openingEditor(entry.name),
                          errorMessage: null
                        }))
                        try {
                          const opened = await store.openFileEditorFromFileSystem(activeTerminalId, entry.path)
                          if (!opened) return
                          updateTabState(activeTerminalId, (current) => ({
                            ...current,
                            statusMessage: t.filesystem.openedInEditor(entry.name)
                          }))
                        } catch (error) {
                          updateTabState(activeTerminalId, (current) => ({
                            ...current,
                            errorMessage: toErrorMessage(error)
                          }))
                        }
                      })()
                    }}
                    title={entry.path}
                  >
                    <span className="filesystem-row-main">
                      <Icon size={14} strokeWidth={2} />
                      <span className="filesystem-row-name">{entry.name}</span>
                    </span>
                    <span className="filesystem-row-meta">
                      {entry.isDirectory ? t.filesystem.directoryLabel : formatFileSize(entry.size)}
                    </span>
                  </div>
                )
              })
            )}
          </div>
        </div>
        {transferTaskList.length > 0 ? (
          <div className="filesystem-transfer-panel">
            <div className="filesystem-transfer-panel-header">{t.filesystem.transferPanelTitle}</div>
            <div className="filesystem-transfer-list">
              {transferTaskList.map((task) => {
                const percent = Math.max(0, Math.min(100, task.percent))
                const taskKindLabel = task.kind === 'move' ? t.filesystem.transferMoveKind : t.filesystem.transferCopyKind
                const progressLabel = task.totalBytes > 0
                  ? `${formatFileSize(task.bytesDone)} / ${formatFileSize(task.totalBytes)}`
                  : `${task.transferredFiles}/${task.totalFiles || task.itemNames.length}`
                const taskName = task.itemNames.length === 1
                  ? task.itemNames[0]
                  : `${task.itemNames[0]} +${task.itemNames.length - 1}`
                const canCancel = (task.status === 'queued' || task.status === 'running') && !task.cancelRequested

                return (
                  <div key={task.id} className={`filesystem-transfer-item is-${task.status}`}>
                    <div className="filesystem-transfer-main">
                      <span className="filesystem-transfer-kind">{taskKindLabel}</span>
                      <span className="filesystem-transfer-name" title={task.itemNames.join(', ')}>{taskName}</span>
                      <span className="filesystem-transfer-status">{getTransferStatusLabel(task.status)}</span>
                      {canCancel ? (
                        <button
                          className="filesystem-transfer-cancel-btn"
                          title={t.filesystem.cancelTransfer}
                          onClick={() => cancelTransferTask(task.id)}
                        >
                          <X size={18} />
                        </button>
                      ) : null}
                    </div>
                    <div className="filesystem-transfer-progress">
                      <span className="filesystem-transfer-progress-track">
                        <span className="filesystem-transfer-progress-fill" style={{ width: `${percent}%` }} />
                      </span>
                      <span className="filesystem-transfer-progress-label">{progressLabel}</span>
                    </div>
                    <div className="filesystem-transfer-message" title={task.errorMessage || task.message || ''}>
                      {task.errorMessage || task.message || ''}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ) : null}
        <div className="filesystem-footnote">
          {clipboard ? t.filesystem.pasteShortcutHint : t.filesystem.doubleClickToOpenEditor}
        </div>
      </div>
    </div>
  )
})
