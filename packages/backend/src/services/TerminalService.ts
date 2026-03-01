import pkg from '@xterm/headless'
import type { Terminal as TerminalType } from '@xterm/headless'
const { Terminal } = pkg
import path from 'path'
import os from 'os'
import type { TerminalBackend, TerminalConfig, TerminalTab, CommandResult, ConnectionType, FileStatInfo, CommandTask } from '../types'
import { NodePtyBackend } from './NodePtyBackend'
import { SSHBackend } from './SSHBackend'
import { escapeShellPathList } from './ShellUtility'
import { TerminalStateStore, type PersistedTerminalRecord } from './terminal/TerminalStateStore'
import { v4 as uuidv4 } from 'uuid'

const MAX_BUFFER_SIZE = 100000 // 100KB
const SCROLLBACK_SIZE = 5000 // Keep up to 5000 lines in virtual terminal
const PERSIST_FLUSH_DELAY_MS = 120
// We do NOT print any wrapper/marker commands in the terminal.
// Instead, we rely on shell integration hooks (installed at shell startup by NodePtyBackend)
// that emit invisible OSC markers on command boundaries.
const OSC_PRECMD_PREFIX = '\x1b]1337;gyshell_precmd'
const OSC_SUFFIX = '\x07'

function stripGyShellOscMarkers(s: string): string {
  return s.replace(/\x1b]1337;gyshell_(?:preexec|precmd)[^\x07]*\x07/g, '')
}

interface RingBuffer {
  content: string
  offset: number
}

type RawEventPublisher = (channel: string, data: unknown) => void
type PendingTaskFinish = {
  requiredWriteSeq: number
  exitCode?: number
}

type TerminalTabSnapshot = {
  id: string
  title: string
  type: ConnectionType
  cols: number
  rows: number
  runtimeState?: 'initializing' | 'ready' | 'exited'
  lastExitCode?: number
}

interface TerminalServiceOptions {
  terminalStateStore?: TerminalStateStore | null
}

export interface RestoreTerminalResult {
  restored: string[]
  failed: Array<{ id: string; reason: string }>
}

const cloneTerminalConfig = (config: TerminalConfig): TerminalConfig =>
  JSON.parse(JSON.stringify(config)) as TerminalConfig

const normalizeTerminalConfigForRuntime = (config: TerminalConfig): TerminalConfig => {
  const normalized = cloneTerminalConfig(config)
  normalized.id = config.id
  normalized.title = config.title
  normalized.cols = Number.isFinite(config.cols) && config.cols > 0 ? Math.max(1, Math.floor(config.cols)) : 80
  normalized.rows = Number.isFinite(config.rows) && config.rows > 0 ? Math.max(1, Math.floor(config.rows)) : 24
  return normalized
}

export class TerminalService {
  private backends: Map<ConnectionType, TerminalBackend> = new Map()
  private terminals: Map<string, TerminalTab> = new Map()
  private terminalConfigs: Map<string, TerminalConfig> = new Map()
  private buffers: Map<string, RingBuffer> = new Map()
  private headlessPtys: Map<string, TerminalType> = new Map()
  private selectionByTerminal: Map<string, string> = new Map()
  private tasksByTerminal: Map<string, Record<string, CommandTask>> = new Map()
  private activeTaskByTerminal: Map<string, string> = new Map()
  private oscParseBufByTerminal: Map<string, string> = new Map()
  private headlessWriteSeqByTerminal: Map<string, number> = new Map()
  private headlessFlushedSeqByTerminal: Map<string, number> = new Map()
  private pendingTaskFinishByTerminal: Map<string, PendingTaskFinish> = new Map()
  private startMarkerByTaskId: Map<string, any> = new Map()
  private onTaskFinishedCallbacks: Map<string, (result: CommandResult) => void> = new Map()
  private primaryLocalTerminalId: string | null = null
  private rawEventPublisher: RawEventPublisher | null = null
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  private readonly terminalStateStore: TerminalStateStore | null

  constructor(options?: TerminalServiceOptions) {
    this.backends.set('local', new NodePtyBackend())
    this.backends.set('ssh', new SSHBackend())
    this.terminalStateStore = options?.terminalStateStore ?? null
  }

  setRawEventPublisher(publisher: RawEventPublisher): void {
    this.rawEventPublisher = publisher
  }

  private listRenderableTerminals(): TerminalTabSnapshot[] {
    return Array.from(this.terminals.values()).map((terminal) => ({
      id: terminal.id,
      title: terminal.title,
      type: terminal.type,
      cols: terminal.cols,
      rows: terminal.rows,
      runtimeState: terminal.runtimeState,
      lastExitCode: terminal.lastExitCode
    }))
  }

  private publishTerminalTabsChanged(): void {
    this.sendToRenderer('terminal:tabs', {
      terminals: this.listRenderableTerminals()
    })
  }

  private getBackend(type: ConnectionType): TerminalBackend {
    const backend = this.backends.get(type)
    if (!backend) {
      throw new Error(`No backend found for connection type: ${type}`)
    }
    return backend
  }

  private mergeTerminalConfigForIdempotent(existing: TerminalConfig, incoming: TerminalConfig): TerminalConfig {
    if (existing.type !== incoming.type) {
      return normalizeTerminalConfigForRuntime(existing)
    }
    return normalizeTerminalConfigForRuntime({
      ...existing,
      ...incoming,
      id: existing.id,
      type: existing.type
    } as TerminalConfig)
  }

  private extractTerminalConfigForPersist(terminal: TerminalTab): TerminalConfig | null {
    const existing = this.terminalConfigs.get(terminal.id)
    if (existing) {
      return normalizeTerminalConfigForRuntime({
        ...existing,
        id: terminal.id,
        title: terminal.title,
        cols: terminal.cols,
        rows: terminal.rows
      } as TerminalConfig)
    }

    if (terminal.type === 'local') {
      return {
        type: 'local',
        id: terminal.id,
        title: terminal.title,
        cols: terminal.cols > 0 ? terminal.cols : 80,
        rows: terminal.rows > 0 ? terminal.rows : 24
      }
    }

    return null
  }

  private getPersistableRecords(): PersistedTerminalRecord[] {
    const records: PersistedTerminalRecord[] = []
    Array.from(this.terminals.values()).forEach((terminal) => {
      const config = this.extractTerminalConfigForPersist(terminal)
      if (!config) return
      records.push({
        id: terminal.id,
        config
      })
    })
    return records
  }

  private persistTerminalStateNow(): void {
    if (!this.terminalStateStore) return
    this.terminalStateStore.save(this.getPersistableRecords())
  }

  private schedulePersistTerminalState(): void {
    if (!this.terminalStateStore) return
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      this.persistTerminalStateNow()
    }, PERSIST_FLUSH_DELAY_MS)
  }

  flushPersistedState(): void {
    if (!this.terminalStateStore) return
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    this.persistTerminalStateNow()
  }

  async restorePersistedTerminals(): Promise<RestoreTerminalResult> {
    if (!this.terminalStateStore) {
      return { restored: [], failed: [] }
    }

    const records = this.terminalStateStore.load()
    if (records.length === 0) {
      return { restored: [], failed: [] }
    }

    const restored: string[] = []
    const failed: Array<{ id: string; reason: string }> = []

    for (const record of records) {
      try {
        await this.createTerminal(record.config)
        restored.push(record.id)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        failed.push({ id: record.id, reason })
      }
    }

    // Prune any entries that could not be restored to avoid repeated startup failures.
    this.persistTerminalStateNow()

    return { restored, failed }
  }

  private async printBanner(terminalId: string): Promise<void> {
    // ANSI Shadow font for "GyShell"
    // Using \x1b[36m for Cyan color
    const banner = `\r\n\x1b[36m  ____         ____  _          _ _ \r\n / ___|_   _  / ___|| |__   ___| | |\r\n| |  _| | | | \\___ \\| '_ \\ / _ \\ | |\r\n| |_| | |_| |  ___) | | | |  __/ | |\r\n \\____|\\__, | |____/|_| |_|\\___|_|_|\r\n       |___/                        \x1b[0m\r\n`

    // Small delay to ensure shell is ready
    setTimeout(() => {
      // Use handleData to inject the banner directly into the UI and headless terminal
      // without sending it as a command to the underlying PTY process.
      this.handleData(terminalId, banner)
    }, 500)
  }

  async createTerminal(rawConfig: TerminalConfig): Promise<TerminalTab> {
    const config = normalizeTerminalConfigForRuntime(rawConfig)

    // Idempotent: renderer may call createTab more than once (dev reload / re-mount).
    const existing = this.terminals.get(config.id)
    if (existing) {
      const existingConfig = this.terminalConfigs.get(config.id)
      const mergedConfig = existingConfig
        ? this.mergeTerminalConfigForIdempotent(existingConfig, config)
        : config

      // Keep size updated
      existing.cols = mergedConfig.cols
      existing.rows = mergedConfig.rows
      // Keep title updated (required)
      existing.title = mergedConfig.title
      
      const headless = this.headlessPtys.get(config.id)
      if (headless) {
        headless.resize(mergedConfig.cols, mergedConfig.rows)
      }

      this.terminalConfigs.set(config.id, mergedConfig)
      this.schedulePersistTerminalState()

      return existing
    }

    const backend = this.getBackend(config.type)
    const ptyId = await backend.spawn(config)

    const tab: TerminalTab = {
      id: config.id,
      ptyId,
      title: config.title,
      cols: config.cols,
      rows: config.rows,
      type: config.type,
      isInitializing: config.type === 'ssh' || (config.type === 'local' && os.platform() === 'win32'), // Enable silence mode for SSH and local Windows
      runtimeState: config.type === 'ssh' || (config.type === 'local' && os.platform() === 'win32') ? 'initializing' : 'ready'
    }

    // Initialize Headless Terminal for AI context
    const headless = new Terminal({
      cols: config.cols,
      rows: config.rows,
      scrollback: SCROLLBACK_SIZE,
      allowProposedApi: true
    })

    this.terminals.set(config.id, tab)
    this.terminalConfigs.set(config.id, config)
    this.buffers.set(config.id, { content: '', offset: 0 })
    this.headlessPtys.set(config.id, headless)
    if (config.type === 'local' && !this.primaryLocalTerminalId) {
      this.primaryLocalTerminalId = config.id
    }

    // Setup data handler
    backend.onData(ptyId, (data: string) => {
      this.handleData(config.id, data)
    })

    // Setup exit handler
    backend.onExit(ptyId, (code: number) => {
      this.handleExit(config.id, code)
    })

    // Print banner for the first local terminal
    if (config.type === 'local' && this.primaryLocalTerminalId === config.id) {
      this.printBanner(config.id)
    }

    this.publishTerminalTabsChanged()
    this.schedulePersistTerminalState()

    return tab
  }

  private handleData(terminalId: string, data: string): void {
    const tab = this.terminals.get(terminalId)
    if (tab) {
      // Sync initialization state and remote OS
      if (tab.isInitializing) {
        if (tab.type === 'ssh') {
          const backend = this.getBackend('ssh') as SSHBackend
          const initState = backend.getInitializationState(tab.ptyId)
          if (initState === 'ready') {
            tab.isInitializing = false
            tab.runtimeState = 'ready'
            this.publishTerminalTabsChanged()
          } else if (initState === 'failed') {
            tab.isInitializing = false
            tab.runtimeState = 'exited'
            tab.lastExitCode = -1
            this.publishTerminalTabsChanged()
          }
        } else {
          // For local silence mode, first meaningful output means shell is ready.
          tab.isInitializing = false
          tab.runtimeState = 'ready'
          this.publishTerminalTabsChanged()
        }
      }

      if (tab.type === 'ssh') {
        const backend = this.getBackend('ssh') as SSHBackend
        if (!tab.remoteOs) {
          tab.remoteOs = backend.getRemoteOs(tab.ptyId)
        }
        if (!tab.systemInfo) {
          backend.getSystemInfo(tab.ptyId).then(info => {
            if (info) tab.systemInfo = info
          })
        }
      } else if (tab.type === 'local' && !tab.remoteOs) {
        const backend = this.getBackend('local')
        tab.remoteOs = backend.getRemoteOs(tab.ptyId)
        if (!tab.systemInfo) {
          backend.getSystemInfo(tab.ptyId).then(info => {
            if (info) tab.systemInfo = info
          })
        }
      }
    }

    // Write to headless terminal for rendering/normalization
    const headless = this.headlessPtys.get(terminalId)
    let writeSeq = 0
    if (headless) {
      writeSeq = (this.headlessWriteSeqByTerminal.get(terminalId) || 0) + 1
      this.headlessWriteSeqByTerminal.set(terminalId, writeSeq)
      headless.write(data, () => {
        const flushed = Math.max(this.headlessFlushedSeqByTerminal.get(terminalId) || 0, writeSeq)
        this.headlessFlushedSeqByTerminal.set(terminalId, flushed)
        this.tryFlushPendingTaskFinish(terminalId)
      })
    }

    // Process OSC markers and strip markers from visual output
    const cleanedData = this.processIncomingData(terminalId, data, writeSeq)

    // Update ring buffer
    const buffer = this.buffers.get(terminalId)
    let currentOffset = 0
    if (buffer) {
      buffer.content += cleanedData
      buffer.offset += cleanedData.length
      currentOffset = buffer.offset

      // Trim if exceeds max size
      if (buffer.content.length > MAX_BUFFER_SIZE) {
        const trimAmount = buffer.content.length - MAX_BUFFER_SIZE
        buffer.content = buffer.content.slice(trimAmount)
      }
    }

    // Send data to renderer
    if (cleanedData) {
      this.sendToRenderer('terminal:data', { terminalId, data: cleanedData, offset: currentOffset })
    }
  }

  private processIncomingData(terminalId: string, rawChunk: string, writeSeq: number): string {
    let buf = this.oscParseBufByTerminal.get(terminalId) || ''
    buf += rawChunk

    let cleanedData = ''

    while (buf.length > 0) {
      const precmdIdx = buf.indexOf(OSC_PRECMD_PREFIX)
      if (precmdIdx === -1) {
        const cleaned = stripGyShellOscMarkers(buf)
        cleanedData += cleaned
        this.appendActiveTaskOutput(terminalId, cleaned)
        buf = ''
        break
      }

      const before = buf.slice(0, precmdIdx)
      const cleanedBefore = stripGyShellOscMarkers(before)
      cleanedData += cleanedBefore
      this.appendActiveTaskOutput(terminalId, cleanedBefore)

      const suffixIdx = buf.indexOf(OSC_SUFFIX, precmdIdx)
      if (suffixIdx === -1) {
        // Wait for the rest of the marker in the next chunk
        break
      }

      const markerContent = buf.slice(precmdIdx, suffixIdx)
      const ecMatch = markerContent.match(/ec=(\d+)/)
      const exitCode = ecMatch ? parseInt(ecMatch[1], 10) : undefined

      this.scheduleTaskFinishAfterHeadlessFlush(terminalId, exitCode, writeSeq)

      buf = buf.slice(suffixIdx + OSC_SUFFIX.length)
    }

    this.oscParseBufByTerminal.set(terminalId, buf)
    return cleanedData
  }

  private scheduleTaskFinishAfterHeadlessFlush(terminalId: string, exitCode: number | undefined, writeSeq: number): void {
    const headless = this.headlessPtys.get(terminalId)
    if (!headless || writeSeq <= 0) {
      this.finishActiveTask(terminalId, exitCode)
      return
    }

    const flushedSeq = this.headlessFlushedSeqByTerminal.get(terminalId) || 0
    if (flushedSeq >= writeSeq) {
      this.finishActiveTask(terminalId, exitCode)
      return
    }

    this.pendingTaskFinishByTerminal.set(terminalId, {
      requiredWriteSeq: writeSeq,
      exitCode
    })
  }

  private tryFlushPendingTaskFinish(terminalId: string): void {
    const pending = this.pendingTaskFinishByTerminal.get(terminalId)
    if (!pending) return
    const flushedSeq = this.headlessFlushedSeqByTerminal.get(terminalId) || 0
    if (flushedSeq < pending.requiredWriteSeq) return
    this.pendingTaskFinishByTerminal.delete(terminalId)
    this.finishActiveTask(terminalId, pending.exitCode)
  }

  private handleExit(terminalId: string, code: number): void {
    const tab = this.terminals.get(terminalId)
    
    // Mark active task as aborted if terminal exits unexpectedly
    const activeTaskId = this.activeTaskByTerminal.get(terminalId)
    if (activeTaskId) {
      const task = this.getTaskMap(terminalId)[activeTaskId]
      if (task && task.status === 'running') {
        task.status = 'aborted'
        task.endTime = Date.now()
        task.exitCode = typeof code === 'number' ? code : -1
      }
      this.activeTaskByTerminal.delete(terminalId)
      this.onTaskFinishedCallbacks.delete(activeTaskId)
      this.startMarkerByTaskId.delete(activeTaskId)
    }
    this.pendingTaskFinishByTerminal.delete(terminalId)
    this.headlessWriteSeqByTerminal.delete(terminalId)
    this.headlessFlushedSeqByTerminal.delete(terminalId)

    // UI lifecycle is user-driven. Do not auto-remove tab metadata on backend exit.
    // We only update runtime state and keep captured output until user closes the tab.
    if (tab) {
      tab.isInitializing = false
      tab.runtimeState = 'exited'
      tab.lastExitCode = typeof code === 'number' ? code : -1
      const config = this.terminalConfigs.get(terminalId)
      if (config) {
        this.terminalConfigs.set(terminalId, {
          ...config,
          title: tab.title,
          cols: tab.cols,
          rows: tab.rows
        } as TerminalConfig)
      }
    }
    
    this.sendToRenderer('terminal:exit', { terminalId, code })
    this.publishTerminalTabsChanged()
    this.schedulePersistTerminalState()
  }

  write(terminalId: string, data: string): void {
    const terminal = this.terminals.get(terminalId)
    if (terminal && terminal.runtimeState === 'ready') {
      const backend = this.getBackend(terminal.type)
      backend.write(terminal.ptyId, data)
    }
  }

  writePaths(terminalId: string, paths: string[]): void {
    const terminal = this.terminals.get(terminalId)
    if (!terminal || paths.length === 0) return
    const backend = this.getBackend(terminal.type)
    const text = escapeShellPathList(paths)
    if (!text) return
    backend.write(terminal.ptyId, text)
  }

  resize(terminalId: string, cols: number, rows: number): void {
    const terminal = this.terminals.get(terminalId)
    if (terminal) {
      terminal.cols = cols
      terminal.rows = rows
      const config = this.terminalConfigs.get(terminalId)
      if (config) {
        this.terminalConfigs.set(terminalId, {
          ...config,
          cols: Number.isFinite(cols) && cols > 0 ? Math.max(1, Math.floor(cols)) : config.cols,
          rows: Number.isFinite(rows) && rows > 0 ? Math.max(1, Math.floor(rows)) : config.rows
        } as TerminalConfig)
      }
      const backend = this.getBackend(terminal.type)
      backend.resize(terminal.ptyId, cols, rows)
      
      const headless = this.headlessPtys.get(terminalId)
      if (headless) {
        headless.resize(cols, rows)
      }
    }
  }

  kill(terminalId: string): void {
    const terminal = this.terminals.get(terminalId)
    if (terminal) {
      const backend = this.getBackend(terminal.type)
      backend.kill(terminal.ptyId)
      
      const headless = this.headlessPtys.get(terminalId)
      if (headless) {
        headless.dispose()
        this.headlessPtys.delete(terminalId)
      }

      // Thoroughly cleanup all memory state for this terminal
      this.terminals.delete(terminalId)
      this.buffers.delete(terminalId)
      this.selectionByTerminal.delete(terminalId)
      this.oscParseBufByTerminal.delete(terminalId)
      this.tasksByTerminal.delete(terminalId)
      const activeTaskId = this.activeTaskByTerminal.get(terminalId)
      if (activeTaskId) {
        this.startMarkerByTaskId.delete(activeTaskId)
      }
      this.activeTaskByTerminal.delete(terminalId)
      this.headlessWriteSeqByTerminal.delete(terminalId)
      this.headlessFlushedSeqByTerminal.delete(terminalId)
      this.pendingTaskFinishByTerminal.delete(terminalId)
      this.terminalConfigs.delete(terminalId)
      if (this.primaryLocalTerminalId === terminalId) {
        const nextLocal = Array.from(this.terminals.values()).find((item) => item.type === 'local')
        this.primaryLocalTerminalId = nextLocal?.id || null
      }
    }
    this.publishTerminalTabsChanged()
    this.schedulePersistTerminalState()
  }

  interrupt(terminalId: string): void {
    const terminal = this.terminals.get(terminalId)
    if (!terminal) return
    const backend = this.getBackend(terminal.type)
    // Send Ctrl+C to interrupt current foreground command.
    backend.write(terminal.ptyId, '\x03')
  }

  getCwd(terminalId: string): string | undefined {
    const terminal = this.terminals.get(terminalId)
    if (!terminal) return undefined
    const backend = this.getBackend(terminal.type)
    return backend.getCwd(terminal.ptyId)
  }

  async getHomeDir(terminalId: string): Promise<string | undefined> {
    const terminal = this.terminals.get(terminalId)
    if (!terminal) return undefined
    const backend = this.getBackend(terminal.type)
    return backend.getHomeDir(terminal.ptyId)
  }

  async readFile(terminalId: string, filePath: string): Promise<Buffer> {
    const terminal = this.terminals.get(terminalId)
    if (!terminal) {
      throw new Error(`Terminal ${terminalId} not found`)
    }
    const resolvedPath = await this.resolvePath(terminalId, filePath)
    const backend = this.getBackend(terminal.type)
    return backend.readFile(terminal.ptyId, resolvedPath)
  }

  async writeFile(terminalId: string, filePath: string, content: string): Promise<void> {
    const terminal = this.terminals.get(terminalId)
    if (!terminal) {
      throw new Error(`Terminal ${terminalId} not found`)
    }
    const resolvedPath = await this.resolvePath(terminalId, filePath)
    const backend = this.getBackend(terminal.type)
    return backend.writeFile(terminal.ptyId, resolvedPath, content)
  }

  async statFile(terminalId: string, filePath: string): Promise<FileStatInfo> {
    const terminal = this.terminals.get(terminalId)
    if (!terminal) {
      throw new Error(`Terminal ${terminalId} not found`)
    }
    const resolvedPath = await this.resolvePath(terminalId, filePath)
    const backend = this.getBackend(terminal.type)
    return backend.statFile(terminal.ptyId, resolvedPath)
  }

  /**
   * Internal path resolution that handles:
   * 1. ~ expansion (home directory)
   * 2. Relative paths (resolves from current CWD)
   * 3. Platform specific separators (uses remoteOs if available)
   */
  private async resolvePath(terminalId: string, filePath: string): Promise<string> {
    const terminal = this.terminals.get(terminalId)
    if (!terminal) return filePath

    const isWindows = terminal.remoteOs === 'windows'
    const pathUtil = isWindows ? path.win32 : path.posix

    let targetPath = filePath

    // 1. Expand ~
    if (targetPath.startsWith('~')) {
      const homeDir = await this.getHomeDir(terminalId)
      if (homeDir) {
        if (targetPath === '~') {
          targetPath = homeDir
        } else if (targetPath.startsWith('~/') || targetPath.startsWith('~\\')) {
          targetPath = pathUtil.join(homeDir, targetPath.slice(2))
        }
      }
    }

    // 2. Resolve relative paths
    if (!pathUtil.isAbsolute(targetPath)) {
      const cwd = this.getCwd(terminalId)
      if (cwd) {
        targetPath = pathUtil.resolve(cwd, targetPath)
      }
    }

    return targetPath
  }

  getBufferDelta(terminalId: string, fromOffset: number): string {
    const buffer = this.buffers.get(terminalId)
    if (!buffer) return ''

    const normalizedFromOffset =
      Number.isFinite(fromOffset) && fromOffset > 0 ? Math.floor(fromOffset) : 0
    const bufferStartOffset = Math.max(0, buffer.offset - buffer.content.length)
    const startIdx = Math.max(0, normalizedFromOffset - bufferStartOffset)
    return buffer.content.slice(startIdx)
  }

  getCurrentOffset(terminalId: string): number {
    const buffer = this.buffers.get(terminalId)
    return buffer?.offset || 0
  }

  /**
   * Get the recent output of the terminal.
   * If lines is not provided, it dynamically uses the current visible rows.
   */
  getRecentOutput(terminalId: string, lines?: number): string {
    const tab = this.terminals.get(terminalId)
    const headless = this.headlessPtys.get(terminalId)
    
    // If lines is not provided, use the synchronized rows from frontend, fallback to 24
    const finalLines = lines ?? (tab?.rows || 24)

    if (!headless) {
      // Fallback to raw buffer if headless is not available
      const buffer = this.buffers.get(terminalId)
      if (!buffer) return ''
      const allLines = buffer.content.split('\n')
      const start = Math.max(0, allLines.length - finalLines)
      return allLines.slice(start).join('\n')
    }
    
    // Use xterm headless buffer for clean, rendered text
    const buffer = headless.buffer.active
    const totalLines = buffer.length
    const startRow = Math.max(0, totalLines - finalLines)
    
    const result: string[] = []
    for (let i = startRow; i < totalLines; i++) {
      const line = buffer.getLine(i)
      if (line) {
        result.push(line.translateToString(true))
      }
    }
    
    return result.join('\n')
  }

  getDisplayTerminals(): TerminalTab[] {
    return Array.from(this.terminals.values())
  }

  getAllTerminals(): TerminalTab[] {
    return Array.from(this.terminals.values()).filter((t) => !t.isInitializing && t.runtimeState === 'ready')
  }

  getCommandTask(terminalId: string, commandId: string): CommandTask | undefined {
    const tab = this.terminals.get(terminalId)
    if (!tab || tab.isInitializing) return undefined
    const taskMap = this.tasksByTerminal.get(terminalId)
    return taskMap ? taskMap[commandId] : undefined
  }

  getCommandTasks(terminalId: string): CommandTask[] {
    const tab = this.terminals.get(terminalId)
    if (!tab || tab.isInitializing) return []
    const taskMap = this.tasksByTerminal.get(terminalId)
    if (!taskMap) return []
    return Object.values(taskMap).sort((a, b) => b.startTime - a.startTime)
  }

  setSelection(terminalId: string, selectionText: string): void {
    this.selectionByTerminal.set(terminalId, selectionText)
  }

  getSelection(terminalId: string): string {
    return this.selectionByTerminal.get(terminalId) || ''
  }
  
  findTerminalId(idOrName: string): string | undefined {
    if (this.terminals.has(idOrName)) return idOrName
    
    // Fuzzy match name? Or exact? User says "if Name match Unique run, else return error info"
    // Let's return all matches so AgentService can decide.
    // But this method just returns one ID if found.
    return undefined
  }

  // Helper for Agent to resolve "ID or Name"
  resolveTerminal(idOrName: string): { found: TerminalTab[], bestMatch?: TerminalTab } {
    if (this.terminals.has(idOrName)) {
        return { found: [this.terminals.get(idOrName)!], bestMatch: this.terminals.get(idOrName) }
    }
    
    const matches = Array.from(this.terminals.values()).filter(t => t.title === idOrName)
    if (matches.length === 1) {
        return { found: matches, bestMatch: matches[0] }
    }
    return { found: matches }
  }

  async runCommandNoWait(terminalId: string, command: string, onFinished?: (result: CommandResult) => void): Promise<string> {
    const taskId = await this.executeCommandInternal(terminalId, command, 'nowait', onFinished)
    return taskId
  }

  async runCommandAndWait(
    terminalId: string,
    command: string,
    opts?: { 
      signal?: AbortSignal; 
      interruptOnAbort?: boolean; 
      onFinished?: (result: CommandResult) => void;
      shouldSkip?: () => boolean;
    }
  ): Promise<CommandResult> {
    const taskId = await this.executeCommandInternal(terminalId, command, 'wait', opts?.onFinished)
    return this.waitForTask(terminalId, taskId, opts)
  }

  async waitForTask(
    terminalId: string,
    taskId: string,
    opts?: { 
      signal?: AbortSignal; 
      interruptOnAbort?: boolean;
      shouldSkip?: () => boolean;
    }
  ): Promise<CommandResult> {
    const startTime = Date.now()
    const timeoutMs = 120_000

    while (true) {
      if (opts?.signal?.aborted) {
        if (opts.interruptOnAbort !== false) {
          this.interrupt(terminalId)
          this.markTaskAborted(terminalId, taskId)
        }
        return { stdoutDelta: 'Command aborted by user.', exitCode: -2, history_command_match_id: taskId }
      }

      // Check if user manually skipped the wait
      if (opts?.shouldSkip?.()) {
        return { 
          stdoutDelta: 'USER_SKIPPED_WAIT', 
          exitCode: -3, 
          history_command_match_id: taskId 
        }
      }

      const task = this.getTaskMap(terminalId)[taskId]
      if (!task) {
        throw new Error(`Task ${taskId} not found.`)
      }

      if (task.status === 'finished') {
        return {
          stdoutDelta: task.output || '',
          exitCode: task.exitCode ?? -1,
          history_command_match_id: taskId
        }
      }

      if (Date.now() - startTime > timeoutMs) {
        return {
          stdoutDelta: 'Command timed out (120s). The process is still running in the background.',
          exitCode: -1,
          history_command_match_id: taskId
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }

  private async executeCommandInternal(
    terminalId: string,
    command: string,
    type: 'wait' | 'nowait',
    onFinished?: (result: CommandResult) => void
  ): Promise<string> {
    const terminal = this.terminals.get(terminalId)
    if (!terminal) {
      throw new Error(`Terminal ${terminalId} not found`)
    }
    if (terminal.runtimeState !== 'ready') {
      throw new Error(`Terminal ${terminal.title || terminal.id} is not ready (state=${terminal.runtimeState || 'unknown'}).`)
    }

    if (this.activeTaskByTerminal.has(terminalId)) {
      const activeTaskId = this.activeTaskByTerminal.get(terminalId)!
      const activeTask = this.getTaskMap(terminalId)[activeTaskId]
      const commandName = activeTask ? activeTask.command : 'unknown'
      throw new Error(
        `There is a running exec_command in the terminal tab: "${commandName}". If you need to end the previous command, use write_stdin to end it, otherwise wait until it finishes.`
      )
    }

    const taskId = uuidv4()
    const startOffset = this.getCurrentOffset(terminalId)
    const headless = this.headlessPtys.get(terminalId)

    const task: CommandTask = {
      id: taskId,
      command,
      type,
      status: 'running',
      startOffset,
      startTime: Date.now(),
      output: '',
      // Scheme 1: Record start line in headless buffer
      startAbsLine: headless ? headless.buffer.active.baseY + headless.buffer.active.cursorY : undefined
    }

    const taskMap = this.getTaskMap(terminalId)
    taskMap[taskId] = task
    if (headless && typeof (headless as any).registerMarker === 'function') {
      const marker = (headless as any).registerMarker(0)
      if (marker) {
        this.startMarkerByTaskId.set(taskId, marker)
      }
    }
    this.activeTaskByTerminal.set(terminalId, taskId)
    if (onFinished) {
      this.onTaskFinishedCallbacks.set(taskId, onFinished)
    }

    const backend = this.getBackend(terminal.type)
    const eol = terminal.remoteOs === 'windows' ? '\r' : '\n'
    backend.write(terminal.ptyId, `${command}${eol}`)
    return taskId
  }

  getActiveTaskId(terminalId: string): string | undefined {
    return this.activeTaskByTerminal.get(terminalId)
  }

  private getTaskMap(terminalId: string): Record<string, CommandTask> {
    const existing = this.tasksByTerminal.get(terminalId)
    if (existing) return existing
    const next: Record<string, CommandTask> = {}
    this.tasksByTerminal.set(terminalId, next)
    return next
  }

  private appendActiveTaskOutput(terminalId: string, chunk: string): void {
    if (!chunk) return
    const taskId = this.activeTaskByTerminal.get(terminalId)
    if (!taskId) return
    const task = this.getTaskMap(terminalId)[taskId]
    if (!task || task.status !== 'running') return
    task.output = (task.output || '') + chunk
  }

  private finishActiveTask(terminalId: string, exitCode?: number): void {
    const taskId = this.activeTaskByTerminal.get(terminalId)
    if (!taskId) return
    const task = this.getTaskMap(terminalId)[taskId]
    if (!task || (task.status !== 'running' && task.status !== 'timeout')) return

    const renderedOutput = this.getRenderedTaskOutput(terminalId, task)
    const streamedOutput = this.stripEchoedCommand(task.output || '', task.command)
    if (renderedOutput !== undefined) {
      const renderedHasContent = renderedOutput.trim().length > 0
      task.output = renderedHasContent || !streamedOutput ? renderedOutput : streamedOutput
    } else {
      task.output = streamedOutput
    }

    task.status = 'finished'
    task.endTime = Date.now()
    task.exitCode = exitCode
    task.endOffset = task.startOffset + task.output.length

    this.activeTaskByTerminal.delete(terminalId)

    const callback = this.onTaskFinishedCallbacks.get(taskId)
    if (callback) {
      this.onTaskFinishedCallbacks.delete(taskId)
      callback({ stdoutDelta: task.output, exitCode, history_command_match_id: taskId })
    }
  }

  private getRenderedTaskOutput(terminalId: string, task: CommandTask): string | undefined {
    const headless = this.headlessPtys.get(terminalId)
    if (!headless) return undefined
    const buffer = headless.buffer.active
    if (!buffer) return undefined

    const marker = this.startMarkerByTaskId.get(task.id)
    const markerLine = marker && typeof marker.line === 'number' ? marker.line : undefined
    if (marker && typeof marker.dispose === 'function') {
      marker.dispose()
    }
    this.startMarkerByTaskId.delete(task.id)

    const startAbsLineFromMarker = markerLine !== undefined && markerLine >= 0 ? markerLine : undefined
    const startAbsLine = startAbsLineFromMarker !== undefined ? startAbsLineFromMarker : task.startAbsLine
    if (startAbsLine === undefined) return undefined

    const endAbsLine = buffer.baseY + buffer.cursorY
    const start = Math.max(0, startAbsLine)
    if (endAbsLine < start) return ''

    const lines: string[] = []
    for (let i = start; i <= endAbsLine; i++) {
      const line = buffer.getLine(i)
      if (line) {
        lines.push(line.translateToString(true))
      }
    }
    return lines.join('\n').trimEnd()
  }

  private markTaskAborted(terminalId: string, taskId: string): void {
    const task = this.getTaskMap(terminalId)[taskId]
    if (!task || task.status !== 'running') return
    task.status = 'aborted'
    task.endTime = Date.now()
    task.exitCode = -2
    task.endOffset = task.startOffset + (task.output?.length || 0)
    this.activeTaskByTerminal.delete(terminalId)
    this.onTaskFinishedCallbacks.delete(taskId)
    this.startMarkerByTaskId.delete(taskId)
  }

  private stripEchoedCommand(output: string, command: string): string {
    if (!output) return output
    const lines = output.split(/\r?\n/)
    if (lines.length === 0) return output
    if (lines[0].includes(command)) {
      return lines.slice(1).join('\n').trimEnd()
    }
    return output.trimEnd()
  }

  private sendToRenderer(channel: string, data: unknown): void {
    if (!this.rawEventPublisher) {
      console.warn(`[TerminalService] Missing rawEventPublisher, dropped event: ${channel}`)
      return
    }
    this.rawEventPublisher(channel, data)
  }
}
