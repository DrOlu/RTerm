import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { FileStatInfo, FileSystemEntry, TerminalBackend, TerminalConfig, TerminalSystemInfo } from '../../types'
import { TerminalService } from '../TerminalService'
import { TerminalStateStore } from './TerminalStateStore'

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

  failSpawnForTerminalId(terminalId: string): void {
    this.spawnFailures.add(terminalId)
  }

  async spawn(config: TerminalConfig): Promise<string> {
    if (this.spawnFailures.has(config.id)) {
      throw new Error(`intentional spawn failure for ${config.id}`)
    }
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

  async listDirectory(_ptyId: string, _dirPath: string): Promise<FileSystemEntry[]> {
    return []
  }

  async createDirectory(_ptyId: string, _dirPath: string): Promise<void> {}

  async createFile(_ptyId: string, _filePath: string): Promise<void> {}

  async deletePath(_ptyId: string, _targetPath: string, _options?: { recursive?: boolean }): Promise<void> {}

  async renamePath(_ptyId: string, _sourcePath: string, _targetPath: string): Promise<void> {}

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
      isRemote: false
    }
  }

  async statFile(_ptyId: string, _filePath: string): Promise<FileStatInfo> {
    return { exists: false, isDirectory: false }
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
