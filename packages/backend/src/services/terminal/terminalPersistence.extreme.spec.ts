import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { FileStatInfo, FileSystemEntry, TerminalBackend, TerminalConfig, TerminalSystemInfo } from '../../types'
import { TerminalService } from '../TerminalService'
import { TerminalStateStore } from './TerminalStateStore'
import { createAutoTerminalConfig } from './terminalConnectionSupport'

const assertCondition = (condition: unknown, message: string): void => {
  if (!condition) {
    throw new Error(message)
  }
}

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(`${message}. expected=${String(expected)} actual=${String(actual)}`)
  }
}

const assertRejects = async (
  action: Promise<unknown>,
  expectedMessage: RegExp,
  message: string,
): Promise<void> => {
  try {
    await action
    throw new Error(`${message}. expected promise rejection`)
  } catch (error) {
    const actualMessage =
      error instanceof Error ? error.message : String(error)
    if (!expectedMessage.test(actualMessage)) {
      throw new Error(
        `${message}. expected=${String(expectedMessage)} actual=${actualMessage}`
      )
    }
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

type FakeSession = {
  id: string
  cwd: string
  dataCallbacks: Array<(data: string) => void>
  exitCallbacks: Array<(code: number) => void>
}

class FakeTerminalBackend implements TerminalBackend {
  private readonly sessions = new Map<string, FakeSession>()
  private readonly spawnFailures = new Set<string>()
  private readonly remoteOsByPtyId = new Map<string, 'unix' | 'windows' | undefined>()
  private readonly systemInfoByPtyId = new Map<string, TerminalSystemInfo | undefined>()
  private readonly homeDirByPtyId = new Map<string, string>()
  private readonly refreshCallbacksByPtyId = new Map<string, () => Promise<void> | void>()
  private readonly listDirectoryCalls: Array<{ ptyId: string; dirPath: string }> = []

  private getPtyIdForTerminalId(terminalId: string): string {
    return `pty-${terminalId}`
  }

  private createDefaultSystemInfo(
    remoteOs: 'unix' | 'windows',
    isRemote: boolean
  ): TerminalSystemInfo {
    if (remoteOs === 'windows') {
      return {
        os: 'Windows',
        platform: 'win32',
        release: '10.0.19045',
        arch: 'x64',
        hostname: 'test-win',
        isRemote,
        shell: 'powershell.exe'
      }
    }

    return {
      os: 'unix',
      platform: 'linux',
      release: 'test',
      arch: 'x64',
      hostname: 'test',
      isRemote
    }
  }

  setRemoteOsForTerminalId(terminalId: string, remoteOs: 'unix' | 'windows' | undefined): void {
    this.remoteOsByPtyId.set(this.getPtyIdForTerminalId(terminalId), remoteOs)
  }

  setSystemInfoForTerminalId(terminalId: string, systemInfo: TerminalSystemInfo | undefined): void {
    this.systemInfoByPtyId.set(this.getPtyIdForTerminalId(terminalId), systemInfo)
  }

  setCwdForTerminalId(terminalId: string, cwd: string): void {
    const session = this.sessions.get(this.getPtyIdForTerminalId(terminalId))
    if (session) {
      session.cwd = cwd
    }
  }

  setHomeDirForTerminalId(terminalId: string, homeDir: string): void {
    this.homeDirByPtyId.set(this.getPtyIdForTerminalId(terminalId), homeDir)
  }

  setRefreshSessionStateForTerminalId(
    terminalId: string,
    callback: () => Promise<void> | void
  ): void {
    this.refreshCallbacksByPtyId.set(this.getPtyIdForTerminalId(terminalId), callback)
  }

  getLastListDirectoryCall(): { ptyId: string; dirPath: string } | undefined {
    return this.listDirectoryCalls[this.listDirectoryCalls.length - 1]
  }

  failSpawnForTerminalId(terminalId: string): void {
    this.spawnFailures.add(terminalId)
  }

  emitDataForTerminalId(terminalId: string, data: string): void {
    const session = this.sessions.get(`pty-${terminalId}`)
    if (!session) return
    session.dataCallbacks.forEach((callback) => callback(data))
  }

  async spawn(config: TerminalConfig): Promise<string> {
    if (this.spawnFailures.has(config.id)) {
      throw new Error(`intentional spawn failure for ${config.id}`)
    }
    const id = this.getPtyIdForTerminalId(config.id)
    this.sessions.set(id, {
      id,
      cwd: '/tmp',
      dataCallbacks: [],
      exitCallbacks: []
    })
    if (!this.remoteOsByPtyId.has(id)) {
      this.remoteOsByPtyId.set(id, 'unix')
    }
    if (!this.systemInfoByPtyId.has(id)) {
      const remoteOs = this.remoteOsByPtyId.get(id) === 'windows' ? 'windows' : 'unix'
      this.systemInfoByPtyId.set(
        id,
        this.createDefaultSystemInfo(remoteOs, config.type === 'ssh')
      )
    }
    return id
  }

  write(_ptyId: string, _data: string): void {}

  resize(_ptyId: string, _cols: number, _rows: number): void {}

  kill(ptyId: string): void {
    const session = this.sessions.get(ptyId)
    if (!session) return
    session.exitCallbacks.forEach((callback) => callback(0))
    this.sessions.delete(ptyId)
    this.remoteOsByPtyId.delete(ptyId)
    this.systemInfoByPtyId.delete(ptyId)
    this.homeDirByPtyId.delete(ptyId)
    this.refreshCallbacksByPtyId.delete(ptyId)
  }

  onData(ptyId: string, callback: (data: string) => void): void {
    const session = this.sessions.get(ptyId)
    if (!session) return
    session.dataCallbacks.push(callback)
  }

  onExit(ptyId: string, callback: (code: number) => void): void {
    const session = this.sessions.get(ptyId)
    if (!session) return
    session.exitCallbacks.push(callback)
  }

  async readFile(_ptyId: string, _filePath: string): Promise<Buffer> {
    return Buffer.alloc(0)
  }

  async writeFile(_ptyId: string, _filePath: string, _content: string): Promise<void> {}

  async readFileChunk(
    _ptyId: string,
    _filePath: string,
    offset: number,
    _chunkSize: number,
    options?: { totalSizeHint?: number }
  ): Promise<{ chunk: Buffer; bytesRead: number; totalSize: number; nextOffset: number; eof: boolean }> {
    const totalSize = Number.isFinite(options?.totalSizeHint) && (options?.totalSizeHint || 0) >= 0
      ? Math.floor(options!.totalSizeHint as number)
      : 0
    return {
      chunk: Buffer.alloc(0),
      bytesRead: 0,
      totalSize,
      nextOffset: offset,
      eof: true
    }
  }

  async writeFileChunk(
    _ptyId: string,
    _filePath: string,
    offset: number,
    content: Buffer
  ): Promise<{ writtenBytes: number; nextOffset: number }> {
    return {
      writtenBytes: content.length,
      nextOffset: offset + content.length
    }
  }

  async writeFileBytes(_ptyId: string, _filePath: string, _content: Buffer): Promise<void> {}

  async listDirectory(ptyId: string, dirPath: string): Promise<FileSystemEntry[]> {
    this.listDirectoryCalls.push({ ptyId, dirPath })
    return []
  }

  async createDirectory(_ptyId: string, _dirPath: string): Promise<void> {}

  async createFile(_ptyId: string, _filePath: string): Promise<void> {}

  async deletePath(_ptyId: string, _targetPath: string, _options?: { recursive?: boolean }): Promise<void> {}

  async renamePath(_ptyId: string, _sourcePath: string, _targetPath: string): Promise<void> {}

  getCwd(ptyId: string): string | undefined {
    return this.sessions.get(ptyId)?.cwd || '/tmp'
  }

  async getHomeDir(ptyId: string): Promise<string | undefined> {
    return this.homeDirByPtyId.get(ptyId) || '/tmp'
  }

  getRemoteOs(_ptyId: string): 'unix' | 'windows' | undefined {
    return this.remoteOsByPtyId.get(_ptyId)
  }

  async getSystemInfo(_ptyId: string): Promise<TerminalSystemInfo | undefined> {
    return this.systemInfoByPtyId.get(_ptyId)
  }

  async refreshSessionState(ptyId: string): Promise<void> {
    const callback = this.refreshCallbacksByPtyId.get(ptyId)
    if (!callback) {
      return
    }
    await callback()
  }

  async statFile(_ptyId: string, _filePath: string): Promise<FileStatInfo> {
    return { exists: false, isDirectory: false }
  }
}

class FakeTerminalOnlyBackend implements TerminalBackend {
  private readonly sessions = new Map<string, FakeSession>()

  async spawn(config: TerminalConfig): Promise<string> {
    const id = `pty-${config.id}`
    this.sessions.set(id, {
      id,
      cwd: '/tmp',
      dataCallbacks: [],
      exitCallbacks: []
    })
    return id
  }

  write(_ptyId: string, _data: string): void {}

  resize(_ptyId: string, _cols: number, _rows: number): void {}

  kill(ptyId: string): void {
    const session = this.sessions.get(ptyId)
    if (!session) return
    session.exitCallbacks.forEach((callback) => callback(0))
    this.sessions.delete(ptyId)
  }

  onData(ptyId: string, callback: (data: string) => void): void {
    const session = this.sessions.get(ptyId)
    if (!session) return
    session.dataCallbacks.push(callback)
  }

  onExit(ptyId: string, callback: (code: number) => void): void {
    const session = this.sessions.get(ptyId)
    if (!session) return
    session.exitCallbacks.push(callback)
  }

  getCwd(_ptyId: string): string | undefined {
    return '/tmp'
  }

  async getHomeDir(_ptyId: string): Promise<string | undefined> {
    return '/tmp'
  }

  getRemoteOs(_ptyId: string): 'unix' | 'windows' | undefined {
    return 'unix'
  }

  async getSystemInfo(_ptyId: string): Promise<TerminalSystemInfo | undefined> {
    return {
      os: 'unix',
      platform: 'linux',
      release: 'test',
      arch: 'x64',
      hostname: 'test',
      isRemote: true
    }
  }
}

const createService = (stateFilePath: string, backend: FakeTerminalBackend): TerminalService => {
  const service = new TerminalService({
    terminalStateStore: new TerminalStateStore(stateFilePath)
  })
  ;(service as any).backends.set('local', backend)
  ;(service as any).backends.set('ssh', backend)
  service.setRawEventPublisher(() => {})
  return service
}

const runCase = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
  await fn()
  console.log(`PASS ${name}`)
}

const run = async (): Promise<void> => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gyshell-terminal-persist-extreme-'))
  const stateFilePath = path.join(tempDir, 'terminal-tabs-state.json')

  try {
    await runCase('state store filters invalid records and de-duplicates by terminal id', async () => {
      fs.writeFileSync(
        stateFilePath,
        JSON.stringify(
          {
            schemaVersion: 1,
            terminals: [
              {
                id: 'local-a',
                config: {
                  type: 'local',
                  id: 'local-a',
                  title: 'Local A',
                  cols: 80,
                  rows: 24
                }
              },
              {
                id: 'local-a',
                config: {
                  type: 'local',
                  id: 'local-a',
                  title: 'Duplicate',
                  cols: 90,
                  rows: 30
                }
              },
              {
                id: 'ssh-bad',
                config: {
                  type: 'ssh',
                  id: 'ssh-bad',
                  title: 'Broken SSH'
                }
              }
            ]
          },
          null,
          2
        ),
        'utf8'
      )

      const store = new TerminalStateStore(stateFilePath)
      const loaded = store.load()
      assertEqual(loaded.length, 1, 'only valid unique records should be loaded')
      assertEqual(loaded[0].id, 'local-a', 'first valid record should be kept')
    })

    await runCase('terminal service persists created tabs and restores them on next startup', async () => {
      const backend1 = new FakeTerminalBackend()
      const service1 = createService(stateFilePath, backend1)
      await service1.createTerminal({
        type: 'local',
        id: 'local-restore-a',
        title: 'Restore A',
        cols: 120,
        rows: 32
      })
      await sleep(220)

      const store = new TerminalStateStore(stateFilePath)
      const snapshot = store.load()
      assertCondition(
        snapshot.some((item) => item.id === 'local-restore-a'),
        'created terminal should be persisted to state store'
      )

      const backend2 = new FakeTerminalBackend()
      const service2 = createService(stateFilePath, backend2)
      const restore = await service2.restorePersistedTerminals()
      assertCondition(
        restore.restored.includes('local-restore-a'),
        'persisted terminal should be restored successfully'
      )
      assertCondition(
        service2.getDisplayTerminals().some((item) => item.id === 'local-restore-a'),
        'restored terminal must exist in display list'
      )
    })

    await runCase('restored idle windows terminals publish runtime metadata before any new output', async () => {
      const store = new TerminalStateStore(stateFilePath)
      store.save([
        {
          id: 'ssh-win-idle',
          config: {
            type: 'ssh',
            id: 'ssh-win-idle',
            title: 'Idle Windows',
            cols: 120,
            rows: 32,
            host: '10.0.0.10',
            port: 22,
            username: 'Administrator',
            authMethod: 'password',
            password: 'secret-password'
          }
        }
      ])

      const backend = new FakeTerminalBackend()
      backend.setRemoteOsForTerminalId('ssh-win-idle', 'windows')
      backend.setSystemInfoForTerminalId('ssh-win-idle', {
        os: 'Windows',
        platform: 'win32',
        release: '10.0.19045',
        arch: 'x64',
        hostname: 'test-win',
        isRemote: true,
        shell: 'powershell.exe'
      })

      const terminalTabEvents: Array<{
        terminals: Array<{
          id: string
          remoteOs?: 'unix' | 'windows'
          systemInfo?: TerminalSystemInfo
        }>
      }> = []

      const service = createService(stateFilePath, backend)
      service.setRawEventPublisher((channel, payload) => {
        if (channel !== 'terminal:tabs') return
        terminalTabEvents.push(payload as {
          terminals: Array<{
            id: string
            remoteOs?: 'unix' | 'windows'
            systemInfo?: TerminalSystemInfo
          }>
        })
      })

      const restore = await service.restorePersistedTerminals()
      assertCondition(
        restore.restored.includes('ssh-win-idle'),
        'windows terminal should restore from persisted state'
      )

      await sleep(20)

      const restored = service.getDisplayTerminals().find((item) => item.id === 'ssh-win-idle')
      assertEqual(restored?.remoteOs, 'windows', 'restored terminal should learn windows PTY metadata without new output')
      assertEqual(
        restored?.systemInfo?.platform,
        'win32',
        'restored terminal should hydrate system info without waiting for handleData'
      )
      assertCondition(
        terminalTabEvents.some((event) =>
          event.terminals.some(
            (terminal) =>
              terminal.id === 'ssh-win-idle' &&
              terminal.remoteOs === 'windows' &&
              terminal.systemInfo?.platform === 'win32'
          )
        ),
        'renderer tab snapshots should be republished once restored windows metadata is available'
      )
    })

    await runCase('failed restores are pruned from persisted state to avoid repeated startup failures', async () => {
      const store = new TerminalStateStore(stateFilePath)
      store.save([
        {
          id: 'local-good',
          config: {
            type: 'local',
            id: 'local-good',
            title: 'Local Good',
            cols: 80,
            rows: 24
          }
        },
        {
          id: 'local-bad',
          config: {
            type: 'local',
            id: 'local-bad',
            title: 'Local Bad',
            cols: 80,
            rows: 24
          }
        }
      ])

      const backend = new FakeTerminalBackend()
      backend.failSpawnForTerminalId('local-bad')
      const service = createService(stateFilePath, backend)
      const restore = await service.restorePersistedTerminals()
      assertCondition(restore.restored.includes('local-good'), 'good record should still restore')
      assertCondition(
        restore.failed.some((item) => item.id === 'local-bad'),
        'failed record should be reported'
      )

      const nextSnapshot = store.load()
      assertCondition(
        nextSnapshot.some((item) => item.id === 'local-good'),
        'successful record should remain in state file'
      )
      assertCondition(
        !nextSnapshot.some((item) => item.id === 'local-bad'),
        'failed record should be pruned after restore'
      )
    })

    await runCase('terminal service must strip internal ready marker from renderer stream and ring buffer', async () => {
      const backend = new FakeTerminalBackend()
      const service = createService(stateFilePath, backend)
      const terminalDataEvents: Array<{ terminalId: string; data: string; offset?: number }> = []
      service.setRawEventPublisher((channel, payload) => {
        if (channel !== 'terminal:data') return
        terminalDataEvents.push(payload as { terminalId: string; data: string; offset?: number })
      })

      await service.createTerminal({
        type: 'local',
        id: 'local-ready-marker-filter',
        title: 'Marker Filter',
        cols: 80,
        rows: 24
      })

      backend.emitDataForTerminalId('local-ready-marker-filter', 'hello\r\n')
      backend.emitDataForTerminalId(
        'local-ready-marker-filter',
        '__GYSHELL_READY__\r\nPS C:\\Users\\TUOTUO_Server> '
      )

      await sleep(20)

      const buffered = service.getBufferDelta('local-ready-marker-filter', 0)
      assertCondition(
        !buffered.includes('__GYSHELL_READY__'),
        'ring buffer should never contain internal ready marker'
      )
      assertCondition(
        buffered.includes('PS C:\\Users\\TUOTUO_Server> '),
        'shell prompt after ready marker should be preserved'
      )
      assertCondition(
        terminalDataEvents.every((item) => !item.data.includes('__GYSHELL_READY__')),
        'renderer stream should never contain internal ready marker'
      )
    })

    await runCase('idempotent terminal recreation must preserve full ssh restore config', async () => {
      const backend = new FakeTerminalBackend()
      const service = createService(stateFilePath, backend)

      await service.createTerminal({
        type: 'ssh',
        id: 'ssh-restore-a',
        title: 'SSH Restore A',
        cols: 100,
        rows: 30,
        host: '10.0.0.5',
        port: 22,
        username: 'root',
        authMethod: 'password',
        password: 'secret-password'
      })
      await service.createTerminal({
        type: 'ssh',
        id: 'ssh-restore-a',
        title: 'SSH Restore A',
        cols: 120,
        rows: 40
      } as any)
      service.flushPersistedState()

      const store = new TerminalStateStore(stateFilePath)
      const snapshot = store.load()
      const sshRecord = snapshot.find((item) => item.id === 'ssh-restore-a')
      assertCondition(!!sshRecord, 'ssh record should remain persistable after idempotent create')
      assertEqual(sshRecord?.config.type, 'ssh', 'ssh record should keep ssh type')
      assertEqual((sshRecord?.config as any).host, '10.0.0.5', 'ssh host should not be lost on idempotent updates')
      assertEqual((sshRecord?.config as any).username, 'root', 'ssh username should not be lost on idempotent updates')
      assertEqual(
        (sshRecord?.config as any).authMethod,
        'password',
        'ssh auth method should not be lost on idempotent updates'
      )
    })

    await runCase('terminal service rejects filesystem APIs for terminal-only connection types', async () => {
      const backend = new FakeTerminalBackend()
      const service = createService(stateFilePath, backend)
      ;(service as any).backends.set('serial', new FakeTerminalOnlyBackend())

      await service.createTerminal({
        type: 'serial',
        id: 'serial-a',
        title: 'Serial A',
        cols: 80,
        rows: 24
      } as any)

      const created = service
        .getDisplayTerminals()
        .find((terminal) => terminal.id === 'serial-a')
      assertCondition(!!created, 'serial terminal should be created successfully')
      assertEqual(
        created?.capabilities.supportsFilesystem,
        false,
        'terminal-only connection types should be marked as not file-capable'
      )
      assertEqual(
        service.getFileSystemIdentity('serial-a'),
        null,
        'terminal-only connection types should not expose filesystem identity'
      )
      await assertRejects(
        service.listDirectory('serial-a'),
        /does not support filesystem operations/i,
        'filesystem requests should fail with explicit capability error'
      )
    })

    await runCase('createAutoTerminalConfig preserves explicit id and type for terminal remounts', async () => {
      const backend = new FakeTerminalBackend()
      const service = createService(stateFilePath, backend)
      ;(service as any).backends.set('serial', new FakeTerminalOnlyBackend())

      await service.createTerminal({
        type: 'serial',
        id: 'serial-remount-a',
        title: 'Serial Remount A',
        cols: 80,
        rows: 24
      } as any)

      const snapshot = service.getDisplayTerminals().map((terminal) => ({
        id: terminal.id,
        title: terminal.title,
        type: terminal.type
      }))
      const normalized = createAutoTerminalConfig(snapshot, {
        type: 'serial',
        id: 'serial-remount-a',
        title: 'Serial Remount A',
        cols: 120,
        rows: 40
      })

      assertEqual(
        normalized.type,
        'serial',
        'explicit terminal-only type should survive auto-config normalization'
      )
      assertEqual(
        normalized.id,
        'serial-remount-a',
        'explicit terminal id should be preserved for idempotent remounts'
      )

      await service.createTerminal(normalized as any)

      const terminals = service.getDisplayTerminals()
      const remounted = terminals.find((terminal) => terminal.id === 'serial-remount-a')
      assertEqual(
        terminals.length,
        1,
        'idempotent remount should not create a duplicate terminal session'
      )
      assertEqual(
        remounted?.cols,
        120,
        'idempotent remount should still update terminal dimensions'
      )
    })

    await runCase('monitor identity scopes ssh tabs by username on the same host', async () => {
      const backend = new FakeTerminalBackend()
      const service = createService(stateFilePath, backend)

      await service.createTerminal({
        type: 'ssh',
        id: 'ssh-root',
        title: 'Root',
        host: 'shared.example.com',
        port: 22,
        username: 'root',
        authMethod: 'password',
        password: 'secret',
        cols: 80,
        rows: 24,
      } as any)

      await service.createTerminal({
        type: 'ssh',
        id: 'ssh-app',
        title: 'App',
        host: 'shared.example.com',
        port: 22,
        username: 'app',
        authMethod: 'password',
        password: 'secret',
        cols: 80,
        rows: 24,
      } as any)

      assertEqual(
        service.getMonitorIdentity('ssh-root'),
        'ssh://root@shared.example.com:22',
        'monitor identity should include the ssh username for privileged session isolation'
      )
      assertEqual(
        service.getMonitorIdentity('ssh-app'),
        'ssh://app@shared.example.com:22',
        'monitor identity should distinguish different usernames on the same host'
      )
    })

    await runCase('terminal-only configs survive persistence and restore', async () => {
      const backend1 = new FakeTerminalBackend()
      const service1 = createService(stateFilePath, backend1)
      ;(service1 as any).backends.set('serial', new FakeTerminalOnlyBackend())

      await service1.createTerminal({
        type: 'serial',
        id: 'serial-restore-a',
        title: 'Serial Restore A',
        cols: 96,
        rows: 28,
        devicePath: '/dev/tty.usbserial-A',
        baudRate: 115200
      } as any)
      service1.flushPersistedState()

      const store = new TerminalStateStore(stateFilePath)
      const snapshot = store.load()
      const serialRecord = snapshot.find((item) => item.id === 'serial-restore-a')
      assertCondition(
        !!serialRecord,
        'terminal-only config should remain in persisted terminal state'
      )
      assertEqual(
        serialRecord?.config.type,
        'serial',
        'persisted terminal-only config should keep its original type'
      )
      assertEqual(
        (serialRecord?.config as any).devicePath,
        '/dev/tty.usbserial-A',
        'persisted terminal-only config should preserve backend-specific fields'
      )

      const backend2 = new FakeTerminalBackend()
      const service2 = createService(stateFilePath, backend2)
      ;(service2 as any).backends.set('serial', new FakeTerminalOnlyBackend())

      const restore = await service2.restorePersistedTerminals()
      assertCondition(
        restore.restored.includes('serial-restore-a'),
        'terminal-only config should restore when its backend is registered'
      )
      assertCondition(
        service2.getDisplayTerminals().some((terminal) => terminal.id === 'serial-restore-a'),
        'restored terminal-only tab should exist in display inventory after restart'
      )
    })

    await runCase('sidecar-backed windows file operations refresh cwd and home before resolving paths', async () => {
      const backend = new FakeTerminalBackend()
      backend.setRemoteOsForTerminalId('ssh-win-sidecar-fs', 'windows')
      backend.setSystemInfoForTerminalId('ssh-win-sidecar-fs', {
        os: 'Windows',
        platform: 'win32',
        release: '10.0.14393.0',
        arch: 'x64',
        hostname: 'ws2016',
        isRemote: true,
        shell: 'powershell.exe'
      })
      const service = createService(stateFilePath, backend)

      await service.createTerminal({
        type: 'ssh',
        id: 'ssh-win-sidecar-fs',
        title: 'Windows Sidecar FS',
        host: '192.168.64.11',
        port: 22,
        username: 'Administrator',
        authMethod: 'password',
        password: 'secret',
        cols: 120,
        rows: 32
      })

      backend.setCwdForTerminalId('ssh-win-sidecar-fs', 'C:\\Users\\Administrator')
      backend.setHomeDirForTerminalId('ssh-win-sidecar-fs', 'C:\\Users\\Administrator')
      backend.setRefreshSessionStateForTerminalId('ssh-win-sidecar-fs', () => {
        backend.setCwdForTerminalId('ssh-win-sidecar-fs', 'C:\\Windows')
        backend.setHomeDirForTerminalId('ssh-win-sidecar-fs', 'C:\\Users\\Administrator')
      })

      const listed = await service.listDirectory('ssh-win-sidecar-fs')
      const resolvedRelative = await service.resolvePathForFileSystem('ssh-win-sidecar-fs', 'System32')
      const resolvedHome = await service.resolvePathForFileSystem('ssh-win-sidecar-fs', '~\\Desktop')

      assertEqual(
        listed.path,
        'C:\\Windows',
        'default directory listing should use the refreshed sidecar cwd after manual prompt changes'
      )
      assertEqual(
        backend.getLastListDirectoryCall()?.dirPath,
        'C:\\Windows',
        'filesystem backend should receive the refreshed cwd for implicit listings'
      )
      assertEqual(
        resolvedRelative,
        'C:\\Windows\\System32',
        'relative path resolution should use the refreshed sidecar cwd'
      )
      assertEqual(
        resolvedHome,
        'C:\\Users\\Administrator\\Desktop',
        'home expansion should use the refreshed sidecar home directory'
      )
    })
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

void run()
  .then(() => {
    console.log('All terminal persistence extreme tests passed.')
  })
  .catch((error) => {
    console.error(error)
    throw error
  })
