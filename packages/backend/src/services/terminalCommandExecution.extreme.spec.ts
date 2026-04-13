import type {
  TerminalBackend,
  TerminalCommandTrackingToken,
  TerminalCommandTrackingUpdate,
  TerminalConfig,
  TerminalSystemInfo
} from '../types'
import { TerminalService } from './TerminalService'

const WINDOWS_OSC_PRECMD = '\x1b]1337;gyshell_precmd;ec=0;cwd_b64=L3RtcA==\x07'
const WINDOWS_OSC_PRECMD_WITH_PROMPT =
  '\x1b]1337;gyshell_precmd;ec=0;cwd_b64=QzpcVXNlcnNcQWRtaW5pc3RyYXRvcg==;home_b64=QzpcVXNlcnNcQWRtaW5pc3RyYXRvcg==\x07'

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(`${message}. expected=${String(expected)} actual=${String(actual)}`)
  }
}

type FakeSession = {
  dataCallbacks: Array<(data: string) => void>
  exitCallbacks: Array<(code: number) => void>
}

class FakeCommandBackend implements TerminalBackend {
  private readonly sessions = new Map<string, FakeSession>()
  private readonly writesByPtyId = new Map<string, string[]>()
  private readonly fileWritesByPtyId = new Map<string, Array<{ path: string; content: string }>>()
  private readonly trackingStateByPtyId = new Map<string, TerminalCommandTrackingUpdate>()
  private prepareTrackingError?: Error
  private pollTrackingError?: Error
  private promptFileDispatch = false
  private promptFileRequestPath?: string
  private promptFileOutputPath?: string
  private writeFileError?: Error

  constructor(
    private readonly remoteOs: 'unix' | 'windows',
    private readonly systemInfo: TerminalSystemInfo,
    private readonly trackingMode?: TerminalCommandTrackingToken['mode']
  ) {}

  private getPtyId(terminalId: string): string {
    return `pty-${terminalId}`
  }

  async spawn(config: TerminalConfig): Promise<string> {
    const ptyId = this.getPtyId(config.id)
    this.sessions.set(ptyId, {
      dataCallbacks: [],
      exitCallbacks: []
    })
    this.writesByPtyId.set(ptyId, [])
    this.fileWritesByPtyId.set(ptyId, [])
    return ptyId
  }

  write(ptyId: string, data: string): void {
    const writes = this.writesByPtyId.get(ptyId)
    if (!writes) {
      throw new Error(`Missing fake session for ${ptyId}`)
    }
    writes.push(data)
  }

  resize(_ptyId: string, _cols: number, _rows: number): void {}

  kill(ptyId: string): void {
    const session = this.sessions.get(ptyId)
    if (!session) {
      return
    }
    session.exitCallbacks.forEach((callback) => callback(0))
    this.sessions.delete(ptyId)
  }

  onData(ptyId: string, callback: (data: string) => void): void {
    const session = this.sessions.get(ptyId)
    if (!session) {
      throw new Error(`Missing fake session for ${ptyId}`)
    }
    session.dataCallbacks.push(callback)
  }

  onExit(ptyId: string, callback: (code: number) => void): void {
    const session = this.sessions.get(ptyId)
    if (!session) {
      throw new Error(`Missing fake session for ${ptyId}`)
    }
    session.exitCallbacks.push(callback)
  }

  getCwd(_ptyId: string): string | undefined {
    return this.remoteOs === 'windows' ? 'C:/Users/Administrator' : '/tmp'
  }

  async getHomeDir(_ptyId: string): Promise<string | undefined> {
    return this.remoteOs === 'windows' ? 'C:/Users/Administrator' : '/tmp'
  }

  getRemoteOs(_ptyId: string): 'unix' | 'windows' | undefined {
    return this.remoteOs
  }

  async getSystemInfo(_ptyId: string): Promise<TerminalSystemInfo | undefined> {
    return this.systemInfo
  }

  async prepareCommandTracking(ptyId: string): Promise<TerminalCommandTrackingToken | undefined> {
    if (this.prepareTrackingError) {
      throw this.prepareTrackingError
    }
    if (!this.trackingMode) {
      return undefined
    }
    const baselineSequence = this.trackingStateByPtyId.get(ptyId)?.sequence || 0
    return {
      mode: this.trackingMode,
      baselineSequence,
      dispatchMode: this.promptFileDispatch ? 'prompt-file' : undefined,
      displayMode: this.promptFileDispatch ? 'synthetic-transcript' : undefined,
      commandRequestPath: this.promptFileDispatch ? this.promptFileRequestPath : undefined,
      commandOutputPath: this.promptFileDispatch ? this.promptFileOutputPath : undefined,
    }
  }

  async pollCommandTracking(
    ptyId: string,
    token: TerminalCommandTrackingToken
  ): Promise<TerminalCommandTrackingUpdate | undefined> {
    if (this.pollTrackingError) {
      throw this.pollTrackingError
    }
    const update = this.trackingStateByPtyId.get(ptyId)
    if (!update || update.mode !== token.mode || update.sequence <= token.baselineSequence) {
      return undefined
    }
    return update
  }

  emitData(terminalId: string, data: string): void {
    const session = this.sessions.get(this.getPtyId(terminalId))
    if (!session) {
      throw new Error(`Missing fake session for ${terminalId}`)
    }
    session.dataCallbacks.forEach((callback) => callback(data))
  }

  getLastWrite(terminalId: string): string {
    const writes = this.writesByPtyId.get(this.getPtyId(terminalId)) || []
    return writes[writes.length - 1] || ''
  }

  getLastFileWrite(terminalId: string): { path: string; content: string } | undefined {
    const writes = this.fileWritesByPtyId.get(this.getPtyId(terminalId)) || []
    return writes[writes.length - 1]
  }

  setTrackingState(terminalId: string, update: TerminalCommandTrackingUpdate): void {
    this.trackingStateByPtyId.set(this.getPtyId(terminalId), update)
  }

  setPrepareTrackingError(error?: Error): void {
    this.prepareTrackingError = error
  }

  setPollTrackingError(error?: Error): void {
    this.pollTrackingError = error
  }

  setPromptFileDispatch(requestPath?: string, outputPath?: string): void {
    this.promptFileDispatch = Boolean(requestPath)
    this.promptFileRequestPath = requestPath
    this.promptFileOutputPath = outputPath
  }

  setWriteFileError(error?: Error): void {
    this.writeFileError = error
  }

  async readFile(): Promise<Buffer> {
    throw new Error('not implemented')
  }

  async writeFile(ptyId: string, filePath: string, content: string): Promise<void> {
    if (this.writeFileError) {
      throw this.writeFileError
    }
    const writes = this.fileWritesByPtyId.get(ptyId)
    if (!writes) {
      throw new Error(`Missing fake session for ${ptyId}`)
    }
    writes.push({ path: filePath, content })
  }

  async readFileChunk(): Promise<any> {
    throw new Error('not implemented')
  }

  async writeFileChunk(): Promise<any> {
    throw new Error('not implemented')
  }

  async statFile(): Promise<any> {
    throw new Error('not implemented')
  }

  async listDirectory(): Promise<any> {
    throw new Error('not implemented')
  }

  async createDirectory(): Promise<void> {
    throw new Error('not implemented')
  }

  async createFile(): Promise<void> {
    throw new Error('not implemented')
  }

  async deletePath(): Promise<void> {
    throw new Error('not implemented')
  }

  async renamePath(): Promise<void> {
    throw new Error('not implemented')
  }

  async writeFileBytes(): Promise<void> {
    throw new Error('not implemented')
  }
}

const createService = (backend: FakeCommandBackend): TerminalService => {
  const service = new TerminalService()
  ;(service as any).backends.set('local', backend)
  ;(service as any).backends.set('ssh', backend)
  service.setRawEventPublisher(() => {})
  return service
}

const runCase = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
  await fn()
  console.log(`PASS ${name}`)
}

const waitUntil = async (
  predicate: () => boolean,
  message: string,
  timeoutMs = 2000
): Promise<void> => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(message)
}

const dumpViewport = (service: TerminalService, terminalId: string, rows: number): string => {
  const headless = (service as any).headlessPtys.get(terminalId)
  if (!headless) {
    return ''
  }
  const buffer = headless.buffer.active
  const start = buffer.baseY
  const end = Math.min(buffer.length - 1, start + rows - 1)
  const lines: string[] = []
  for (let i = start; i <= end; i += 1) {
    const line = buffer.getLine(i)
    lines.push(line ? line.translateToString(true) : '')
  }
  return lines.join('\n')
}

const run = async (): Promise<void> => {
  await runCase('windows command waits can finish from an explicit marker even when the marker is chunked', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.14393',
      arch: 'x64',
      hostname: 'ws2016',
      isRemote: false,
      shell: 'powershell.exe'
    })
    const service = createService(backend)

    await service.createTerminal({
      type: 'local',
      id: 'win-local',
      title: 'Windows Local',
      cols: 120,
      rows: 32
    })

    const taskId = await service.runCommandNoWait('win-local', 'Get-Date')
    const waitPromise = service.waitForTask('win-local', taskId)
    const payload = backend.getLastWrite('win-local')

    assertEqual(payload, 'Get-Date\r', 'windows command execution should preserve the original command text')

    backend.emitData('win-local', '2026-04-03 22:12:00\r\n__GYSHELL_TASK_FIN')
    backend.emitData('win-local', 'ISH__::ec=0\r\n')

    const result = await waitPromise

    assertEqual(result.exitCode, 0, 'windows explicit marker should carry the exit code')
    assertEqual(
      result.stdoutDelta.trim(),
      '2026-04-03 22:12:00',
      'windows marker line should be stripped from the task output'
    )
  })

  await runCase('windows finish markers are stripped even when they follow no-newline output', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.17763',
      arch: 'x64',
      hostname: 'ws2019',
      isRemote: false,
      shell: 'powershell.exe'
    })
    const service = createService(backend)

    await service.createTerminal({
      type: 'local',
      id: 'win-local-inline-marker',
      title: 'Windows Local Inline Marker',
      cols: 120,
      rows: 32
    })

    const taskId = await service.runCommandNoWait('win-local-inline-marker', 'Write-Host -NoNewline "hello"')
    const waitPromise = service.waitForTask('win-local-inline-marker', taskId)

    backend.emitData('win-local-inline-marker', 'hello__GYSHELL_TASK_FINISH__::ec=0\r\n')

    const result = await waitPromise

    assertEqual(result.exitCode, 0, 'inline finish markers should still carry the exit code')
    assertEqual(result.stdoutDelta, 'hello', 'inline finish markers should be stripped without losing visible output')
  })

  await runCase('windows local downlevel sessions keep the raw command visible and finish through the sidecar tracker', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.14393',
      arch: 'x64',
      hostname: 'ws2016-local',
      isRemote: false,
      shell: 'powershell.exe'
    }, 'windows-powershell-sidecar')
    const service = createService(backend)

    await service.createTerminal({
      type: 'local',
      id: 'win-local-sidecar',
      title: 'Windows Local Sidecar',
      cols: 120,
      rows: 32
    })

    const taskId = await service.runCommandNoWait('win-local-sidecar', 'Write-Output 456')
    const waitPromise = service.waitForTask('win-local-sidecar', taskId)
    const payload = backend.getLastWrite('win-local-sidecar')

    assertEqual(
      payload,
      'Write-Output 456\r',
      'downlevel local windows commands should stay raw on the visible terminal'
    )

    backend.emitData('win-local-sidecar', '456\r\n')
    backend.emitData('win-local-sidecar', 'PS C:\\Windows>\r\n')
    backend.setTrackingState('win-local-sidecar', {
      mode: 'windows-powershell-sidecar',
      sequence: 4,
      exitCode: 0,
      cwd: 'C:/Windows',
      homeDir: 'C:/Users/Administrator'
    })

    const result = await waitPromise

    assertEqual(result.exitCode, 0, 'local windows sidecar tracking should finish the task')
    assertEqual(result.stdoutDelta.trim(), '456', 'local windows sidecar should keep task output clean')
  })

  await runCase('windows sidecar prompt-file dispatch writes a hidden request file and triggers prompt execution with a bare enter', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.14393',
      arch: 'x64',
      hostname: 'ws2016-local',
      isRemote: false,
      shell: 'powershell.exe'
    }, 'windows-powershell-sidecar')
    backend.setPromptFileDispatch(
      'C:/Windows/Temp/GyShell/exec-request.b64',
      'C:/Windows/Temp/GyShell/exec-output.txt'
    )
    const service = createService(backend)

    await service.createTerminal({
      type: 'local',
      id: 'win-local-prompt-file',
      title: 'Windows Local Prompt File',
      cols: 120,
      rows: 32
    })

    const taskId = await service.runCommandNoWait('win-local-prompt-file', 'Get-Content \"$env:TEMP\\\\demo.txt\"')
    const waitPromise = service.waitForTask('win-local-prompt-file', taskId)
    const fileWrite = backend.getLastFileWrite('win-local-prompt-file')

    assertEqual(
      fileWrite?.path,
      'C:/Windows/Temp/GyShell/exec-request.b64',
      'prompt-file dispatch should target the hidden request file path from the backend token'
    )
    assertEqual(
      Buffer.from(fileWrite?.content || '', 'base64').toString('utf8'),
      'Get-Content \"$env:TEMP\\\\demo.txt\"',
      'prompt-file dispatch should store the original command text as base64 in the hidden request file'
    )
    assertEqual(
      backend.getLastWrite('win-local-prompt-file'),
      '\r',
      'prompt-file dispatch should only send a bare enter to trigger the prompt hook'
    )

    backend.setTrackingState('win-local-prompt-file', {
      mode: 'windows-powershell-sidecar',
      sequence: 1,
      exitCode: 0,
      cwd: 'C:/Users/Administrator',
      homeDir: 'C:/Users/Administrator',
      output: 'demo-output\r\n'
    })

    const result = await waitPromise
    assertEqual(result.exitCode, 0, 'prompt-file dispatch should still complete through the sidecar tracker')
    assertEqual(result.stdoutDelta.trim(), 'demo-output', 'prompt-file dispatch should preserve the visible command output')
  })

  await runCase('windows sidecar prompt-file dispatch falls back to typed command injection when the hidden request write fails', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.14393',
      arch: 'x64',
      hostname: 'ws2016-local',
      isRemote: false,
      shell: 'powershell.exe'
    }, 'windows-powershell-sidecar')
    backend.setPromptFileDispatch(
      'C:/Windows/Temp/GyShell/exec-request.b64',
      'C:/Windows/Temp/GyShell/exec-output.txt'
    )
    backend.setWriteFileError(new Error('temporary write failure'))
    const service = createService(backend)

    await service.createTerminal({
      type: 'local',
      id: 'win-local-prompt-file-fallback',
      title: 'Windows Local Prompt File Fallback',
      cols: 120,
      rows: 32
    })

    const taskId = await service.runCommandNoWait('win-local-prompt-file-fallback', 'Get-Date')
    const waitPromise = service.waitForTask('win-local-prompt-file-fallback', taskId)

    assertEqual(
      backend.getLastWrite('win-local-prompt-file-fallback'),
      'Get-Date\r',
      'prompt-file dispatch failures should fall back to the normal visible command write path'
    )

    backend.emitData('win-local-prompt-file-fallback', '2026-04-04\r\n')
    backend.emitData('win-local-prompt-file-fallback', 'PS C:\\Users\\Administrator>\r\n')
    backend.setTrackingState('win-local-prompt-file-fallback', {
      mode: 'windows-powershell-sidecar',
      sequence: 1,
      exitCode: 0,
      cwd: 'C:/Users/Administrator',
      homeDir: 'C:/Users/Administrator'
    })

    const result = await waitPromise
    assertEqual(result.exitCode, 0, 'fallback command injection should still complete through the sidecar tracker')
  })

  await runCase('windows sidecar prompt-file dispatch keeps the headless viewport clean on downlevel hosts', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.14393',
      arch: 'x64',
      hostname: 'ws2016-local',
      isRemote: false,
      shell: 'powershell.exe'
    }, 'windows-powershell-sidecar')
    backend.setPromptFileDispatch(
      'C:/Windows/Temp/GyShell/exec-request.b64',
      'C:/Windows/Temp/GyShell/exec-output.txt'
    )
    const service = createService(backend)

    await service.createTerminal({
      type: 'local',
      id: 'win-local-synthetic-display',
      title: 'Windows Local Synthetic Display',
      cols: 120,
      rows: 20
    })

    backend.emitData('win-local-synthetic-display', 'PS C:\\Users\\Administrator> ')

    const taskId = await service.runCommandNoWait(
      'win-local-synthetic-display',
      'Write-Output 123'
    )
    const waitPromise = service.waitForTask('win-local-synthetic-display', taskId)

    backend.emitData(
      'win-local-synthetic-display',
      '\x1b[3;1HPS C:\\Users\\Administrator> Write-Output 123\x1b[4;1HrdwareAbstractionLayer'
    )
    backend.setTrackingState('win-local-synthetic-display', {
      mode: 'windows-powershell-sidecar',
      sequence: 2,
      exitCode: 0,
      cwd: 'C:/Users/Administrator',
      homeDir: 'C:/Users/Administrator',
      output: '123\r\n'
    })

    const result = await waitPromise
    const viewport = dumpViewport(service, 'win-local-synthetic-display', 6)

    assertEqual(result.exitCode, 0, 'synthetic display sidecar tasks should still complete')
    assertEqual(result.stdoutDelta.trim(), '123', 'synthetic display should preserve the normalized stdout')
    if (!viewport.includes('PS C:\\Users\\Administrator> Write-Output 123')) {
      throw new Error('synthetic display should render a clean prompt+command line in headless xterm')
    }
    if (!viewport.includes('123')) {
      throw new Error('synthetic display should render command output in headless xterm')
    }
    if (viewport.includes('rdwareAbstractionLayer')) {
      throw new Error('synthetic display should prefer hidden clean output over noisy raw shellhost fragments')
    }
    if (viewport.includes('\x1b[')) {
      throw new Error('synthetic display should not leak raw VT control sequences into the headless viewport')
    }
  })

  await runCase('prepareCommandTracking failures do not block command dispatch', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.14393',
      arch: 'x64',
      hostname: 'ws2016-local',
      isRemote: false,
      shell: 'powershell.exe'
    }, 'windows-powershell-sidecar')
    backend.setPrepareTrackingError(new Error('temporary marker read failure'))
    const service = createService(backend)

    await service.createTerminal({
      type: 'local',
      id: 'win-local-prepare-error',
      title: 'Windows Local Prepare Error',
      cols: 120,
      rows: 32
    })

    await service.runCommandNoWait('win-local-prepare-error', 'Write-Output 789')

    assertEqual(
      backend.getLastWrite('win-local-prepare-error'),
      'Write-Output 789\r',
      'command dispatch should continue even when command tracking preparation fails'
    )
  })

  await runCase('windows ssh downlevel sessions keep the raw command visible and finish through the sidecar tracker', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.14393',
      arch: 'x64',
      hostname: 'ws2016',
      isRemote: true,
      shell: 'powershell.exe'
    }, 'windows-powershell-sidecar')
    const service = createService(backend)

    await service.createTerminal({
      type: 'ssh',
      id: 'win-ssh',
      title: 'Windows SSH',
      host: '192.168.64.11',
      port: 22,
      username: 'Administrator',
      authMethod: 'password',
      password: 'secret',
      cols: 120,
      rows: 32
    })
    const terminal = service.getDisplayTerminals().find((item) => item.id === 'win-ssh')
    if (!terminal) {
      throw new Error('Missing Windows SSH terminal')
    }
    terminal.isInitializing = false
    terminal.runtimeState = 'ready'
    terminal.remoteOs = 'windows'

    const taskId = await service.runCommandNoWait('win-ssh', 'Write-Output 123')
    const waitPromise = service.waitForTask('win-ssh', taskId)
    const payload = backend.getLastWrite('win-ssh')

    assertEqual(
      payload,
      'Write-Output 123\r',
      'downlevel windows ssh commands should stay raw on the visible terminal'
    )

    backend.emitData('win-ssh', '123\r\n')
    backend.emitData('win-ssh', 'PS C:\\Users\\Administrator>\r\n')
    backend.setTrackingState('win-ssh', {
      mode: 'windows-powershell-sidecar',
      sequence: 2,
      exitCode: 0,
      cwd: 'C:/Users/Administrator',
      homeDir: 'C:/Users/Administrator'
    })

    const result = await waitPromise

    assertEqual(result.exitCode, 0, 'windows ssh sidecar tracking should finish the task')
    assertEqual(result.stdoutDelta.trim(), '123', 'windows ssh sidecar mode should keep task output clean')
  })

  await runCase('windows sidecar tracking waits for the rendered prompt before finalizing delayed output', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.14393',
      arch: 'x64',
      hostname: 'ws2016',
      isRemote: true,
      shell: 'powershell.exe'
    }, 'windows-powershell-sidecar')
    const service = createService(backend) as any
    service.commandTrackingPollIntervalMs = 10
    service.commandTrackingPromptSyncPollIntervalMs = 10

    await service.createTerminal({
      type: 'ssh',
      id: 'win-ssh-delayed-prompt',
      title: 'Windows SSH Delayed Prompt',
      host: '192.168.64.11',
      port: 22,
      username: 'Administrator',
      authMethod: 'password',
      password: 'secret',
      cols: 120,
      rows: 32
    })
    const terminal = service.getDisplayTerminals().find((item: any) => item.id === 'win-ssh-delayed-prompt')
    if (!terminal) {
      throw new Error('Missing Windows SSH delayed prompt terminal')
    }
    terminal.isInitializing = false
    terminal.runtimeState = 'ready'
    terminal.remoteOs = 'windows'

    const taskId = await service.runCommandNoWait('win-ssh-delayed-prompt', 'Write-Output delayed')
    backend.setTrackingState('win-ssh-delayed-prompt', {
      mode: 'windows-powershell-sidecar',
      sequence: 9,
      exitCode: 0,
      cwd: 'C:/Windows',
      homeDir: 'C:/Users/Administrator'
    })

    setTimeout(() => {
      backend.emitData('win-ssh-delayed-prompt', 'delayed\r\n')
      backend.emitData('win-ssh-delayed-prompt', 'PS C:\\Windows>\r\n')
    }, 200)

    const result = await service.waitForTask('win-ssh-delayed-prompt', taskId)

    assertEqual(result.exitCode, 0, 'sidecar prompt sync should still preserve the exit code')
    assertEqual(
      result.stdoutDelta.trim(),
      'delayed',
      'sidecar prompt sync should wait for delayed stdout and prompt bytes before finishing'
    )
  })

  await runCase('windows output normalization preserves prompt-like text that belongs to real command output', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.14393',
      arch: 'x64',
      hostname: 'ws2016',
      isRemote: true,
      shell: 'powershell.exe'
    }, 'windows-powershell-sidecar')
    const service = createService(backend)

    await service.createTerminal({
      type: 'ssh',
      id: 'win-ssh-prompt-text',
      title: 'Windows SSH Prompt Text',
      host: '192.168.64.11',
      port: 22,
      username: 'Administrator',
      authMethod: 'password',
      password: 'secret',
      cols: 120,
      rows: 32
    })
    const terminal = service.getDisplayTerminals().find((item: any) => item.id === 'win-ssh-prompt-text')
    if (!terminal) {
      throw new Error('Missing Windows SSH prompt text terminal')
    }
    terminal.isInitializing = false
    terminal.runtimeState = 'ready'
    terminal.remoteOs = 'windows'

    const taskId = await service.runCommandNoWait('win-ssh-prompt-text', 'Write-Output "done"')
    const waitPromise = service.waitForTask('win-ssh-prompt-text', taskId)

    backend.emitData('win-ssh-prompt-text', 'Example transcript: PS C:\\repo> npm test\r\n')
    backend.emitData('win-ssh-prompt-text', 'done\r\n')
    backend.emitData('win-ssh-prompt-text', 'PS C:\\Users\\Administrator>\r\n')
    backend.setTrackingState('win-ssh-prompt-text', {
      mode: 'windows-powershell-sidecar',
      sequence: 7,
      exitCode: 0,
      cwd: 'C:/Users/Administrator',
      homeDir: 'C:/Users/Administrator'
    })

    const result = await waitPromise

    if (!result.stdoutDelta.includes('Example transcript: PS C:\\repo> npm test')) {
      throw new Error('prompt-like text that belongs to real output should be preserved verbatim')
    }
  })

  await runCase('windows output normalization preserves standalone prompt-looking output lines', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.14393',
      arch: 'x64',
      hostname: 'ws2016',
      isRemote: true,
      shell: 'powershell.exe'
    }, 'windows-powershell-sidecar')
    const service = createService(backend)

    await service.createTerminal({
      type: 'ssh',
      id: 'win-ssh-standalone-prompt-output',
      title: 'Windows SSH Standalone Prompt Output',
      host: '192.168.64.11',
      port: 22,
      username: 'Administrator',
      authMethod: 'password',
      password: 'secret',
      cols: 120,
      rows: 32
    })
    const terminal = service
      .getDisplayTerminals()
      .find((item: any) => item.id === 'win-ssh-standalone-prompt-output')
    if (!terminal) {
      throw new Error('Missing Windows SSH standalone prompt terminal')
    }
    terminal.isInitializing = false
    terminal.runtimeState = 'ready'
    terminal.remoteOs = 'windows'

    const taskId = await service.runCommandNoWait(
      'win-ssh-standalone-prompt-output',
      "Write-Output 'PS C:\\repo>'"
    )
    const waitPromise = service.waitForTask('win-ssh-standalone-prompt-output', taskId)

    backend.emitData('win-ssh-standalone-prompt-output', 'PS C:\\repo>\r\n')
    backend.emitData('win-ssh-standalone-prompt-output', 'done\r\n')
    backend.emitData('win-ssh-standalone-prompt-output', 'PS C:\\Users\\Administrator>\r\n')
    backend.setTrackingState('win-ssh-standalone-prompt-output', {
      mode: 'windows-powershell-sidecar',
      sequence: 8,
      exitCode: 0,
      cwd: 'C:/Users/Administrator',
      homeDir: 'C:/Users/Administrator'
    })

    const result = await waitPromise

    if (!result.stdoutDelta.includes('PS C:\\repo>')) {
      throw new Error('standalone prompt-looking output should be preserved')
    }
    if (result.stdoutDelta.includes('PS C:\\Users\\Administrator>')) {
      throw new Error('the trailing shell prompt should still be removed from finished output')
    }
  })

  await runCase('windows ssh sidecar output still prefers cleaned streamed data when rendered output collapses to a prompt', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.14393',
      arch: 'x64',
      hostname: 'ws2016',
      isRemote: true,
      shell: 'powershell.exe'
    }, 'windows-powershell-sidecar')
    const service = createService(backend)

    await service.createTerminal({
      type: 'ssh',
      id: 'win-ssh-noise',
      title: 'Windows SSH Noise',
      host: '192.168.64.11',
      port: 22,
      username: 'Administrator',
      authMethod: 'password',
      password: 'secret',
      cols: 120,
      rows: 32
    })
    const terminal = service.getDisplayTerminals().find((item) => item.id === 'win-ssh-noise')
    if (!terminal) {
      throw new Error('Missing Windows SSH noise terminal')
    }
    terminal.isInitializing = false
    terminal.runtimeState = 'ready'
    terminal.remoteOs = 'windows'

    ;(service as any).getRenderedTaskOutput = () => 'PS C:\\Users\\Administrator>'

    const taskId = await service.runCommandNoWait('win-ssh-noise', 'Write-Output 123')
    const waitPromise = service.waitForTask('win-ssh-noise', taskId)
    const payload = backend.getLastWrite('win-ssh-noise').trim()

    backend.emitData('win-ssh-noise', `\x1b[2J\x1b[HPS C:\\Users\\Administrator>${payload}\r\n`)
    backend.emitData('win-ssh-noise', '123\r\n')
    backend.emitData('win-ssh-noise', 'PS C:\\Users\\Administrator>\r\n')
    backend.setTrackingState('win-ssh-noise', {
      mode: 'windows-powershell-sidecar',
      sequence: 3,
      exitCode: 0,
      cwd: 'C:/Users/Administrator',
      homeDir: 'C:/Users/Administrator'
    })

    const result = await waitPromise

    assertEqual(
      result.stdoutDelta.trim(),
      '123',
      'windows ssh cleanup should keep stdout even when rendered output degenerates to a prompt'
    )
  })

  await runCase('modern windows output prefers rendered text when streamed output is polluted by repeated command echoes', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.26200',
      arch: 'x64',
      hostname: 'win11',
      isRemote: true,
      shell: 'powershell.exe'
    })
    const service = createService(backend) as any

    await service.createTerminal({
      type: 'ssh',
      id: 'win-ssh-modern-echo-noise',
      title: 'Windows SSH Modern Echo Noise',
      host: '192.168.64.12',
      port: 22,
      username: 'Administrator',
      authMethod: 'password',
      password: 'secret',
      cols: 120,
      rows: 32
    })
    const terminal = service.getDisplayTerminals().find((item: any) => item.id === 'win-ssh-modern-echo-noise')
    if (!terminal) {
      throw new Error('Missing Windows SSH modern echo noise terminal')
    }
    terminal.isInitializing = false
    terminal.runtimeState = 'ready'
    terminal.remoteOs = 'windows'

    service.getRenderedTaskOutput = () => 'WIN_OK'

    const taskId = await service.runCommandNoWait('win-ssh-modern-echo-noise', 'cmd /c "echo WIN_OK"')
    const waitPromise = service.waitForTask('win-ssh-modern-echo-noise', taskId)

    backend.emitData(
      'win-ssh-modern-echo-noise',
      `cmd /c "echcmd /c "echocmd /c "echo WIN_OK"\r\nWIN_OK\r\n${WINDOWS_OSC_PRECMD_WITH_PROMPT}PS C:\\Users\\Administrator> `
    )

    const result = await waitPromise

    assertEqual(
      result.stdoutDelta,
      'WIN_OK',
      'modern windows waits should prefer clean rendered output over fragmented command-echo pollution'
    )
  })

  await runCase('modern windows output preserves standalone prompt-looking output lines', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.26200',
      arch: 'x64',
      hostname: 'win11',
      isRemote: true,
      shell: 'powershell.exe'
    })
    const service = createService(backend)

    await service.createTerminal({
      type: 'ssh',
      id: 'win-ssh-modern-prompt-output',
      title: 'Windows SSH Modern Prompt Output',
      host: '192.168.64.12',
      port: 22,
      username: 'Administrator',
      authMethod: 'password',
      password: 'secret',
      cols: 120,
      rows: 32
    })
    const terminal = service.getDisplayTerminals().find((item: any) => item.id === 'win-ssh-modern-prompt-output')
    if (!terminal) {
      throw new Error('Missing Windows SSH modern prompt output terminal')
    }
    terminal.isInitializing = false
    terminal.runtimeState = 'ready'
    terminal.remoteOs = 'windows'

    const taskId = await service.runCommandNoWait(
      'win-ssh-modern-prompt-output',
      "Write-Output 'PS C:\\repo>'"
    )
    const waitPromise = service.waitForTask('win-ssh-modern-prompt-output', taskId)

    backend.emitData(
      'win-ssh-modern-prompt-output',
      `Write-Output 'PS C:\\repo>'\r\nPS C:\\repo>\r\n${WINDOWS_OSC_PRECMD_WITH_PROMPT}PS C:\\Users\\Administrator> `
    )

    const result = await waitPromise

    assertEqual(
      result.stdoutDelta,
      'PS C:\\repo>',
      'modern windows waits should preserve standalone prompt-looking output while still stripping the trailing shell prompt'
    )
  })

  await runCase('windows sidecar tracking failures fail fast instead of hanging until the wait timeout', async () => {
    const backend = new FakeCommandBackend('windows', {
      os: 'Windows',
      platform: 'win32',
      release: '10.0.14393',
      arch: 'x64',
      hostname: 'ws2016',
      isRemote: true,
      shell: 'powershell.exe'
    }, 'windows-powershell-sidecar')
    backend.setPollTrackingError(new Error('sftp channel reset'))
    const service = createService(backend) as any
    service.commandTrackingPollIntervalMs = 10
    service.commandTrackingMaxConsecutiveErrors = 2

    await service.createTerminal({
      type: 'ssh',
      id: 'win-ssh-tracking-failure',
      title: 'Windows SSH Tracking Failure',
      host: '192.168.64.11',
      port: 22,
      username: 'Administrator',
      authMethod: 'password',
      password: 'secret',
      cols: 120,
      rows: 32
    })
    const terminal = service.getDisplayTerminals().find((item: any) => item.id === 'win-ssh-tracking-failure')
    if (!terminal) {
      throw new Error('Missing Windows SSH tracking failure terminal')
    }
    terminal.isInitializing = false
    terminal.runtimeState = 'ready'
    terminal.remoteOs = 'windows'

    const taskId = await service.runCommandNoWait('win-ssh-tracking-failure', 'Write-Output 123')
    backend.emitData('win-ssh-tracking-failure', '123\r\n')
    const result = await service.waitForTask('win-ssh-tracking-failure', taskId)

    assertEqual(result.exitCode, -1, 'tracking loss should end the wait with an explicit failure code')
    if (!result.stdoutDelta.includes('Hidden command-tracking channel failed')) {
      throw new Error('tracking loss should surface a clear diagnostic instead of timing out silently')
    }
  })

  await runCase('unix commands continue to use the shell-integration OSC path without wrapping', async () => {
    const backend = new FakeCommandBackend('unix', {
      os: 'linux',
      platform: 'linux',
      release: '6.8.0',
      arch: 'x64',
      hostname: 'ubuntu',
      isRemote: false,
      shell: '/bin/bash'
    })
    const service = createService(backend)

    await service.createTerminal({
      type: 'local',
      id: 'unix-local',
      title: 'Unix Local',
      cols: 120,
      rows: 32
    })

    const taskId = await service.runCommandNoWait('unix-local', 'printf test')
    const waitPromise = service.waitForTask('unix-local', taskId)
    const payload = backend.getLastWrite('unix-local')

    assertEqual(payload, 'printf test\n', 'unix command execution should stay unwrapped')

    backend.emitData('unix-local', `test${WINDOWS_OSC_PRECMD}\n`)
    const result = await waitPromise

    assertEqual(result.exitCode, 0, 'unix osc marker should still finish the task')
    assertEqual(result.stdoutDelta.trim(), 'test', 'unix output should remain visible')
  })

  await runCase('waitForTask suppresses nowait finish callback when manual wait consumes completion', async () => {
    const backend = new FakeCommandBackend('unix', {
      os: 'linux',
      platform: 'linux',
      release: '6.8.0',
      arch: 'x64',
      hostname: 'ubuntu',
      isRemote: false,
      shell: '/bin/bash'
    })
    const service = createService(backend)

    await service.createTerminal({
      type: 'local',
      id: 'unix-nowait-suppressed',
      title: 'Unix Nowait Suppressed',
      cols: 120,
      rows: 32
    })

    let callbackCount = 0
    const taskId = await service.runCommandNoWait('unix-nowait-suppressed', 'printf suppressed', () => {
      callbackCount += 1
    })
    const waitPromise = service.waitForTask('unix-nowait-suppressed', taskId, {
      suppressFinishCallback: true
    })

    backend.emitData('unix-nowait-suppressed', `suppressed${WINDOWS_OSC_PRECMD}\n`)
    const result = await waitPromise

    assertEqual(result.exitCode, 0, 'manual wait should still receive the finished result')
    assertEqual(result.stdoutDelta.trim(), 'suppressed', 'manual wait should receive command output')
    assertEqual(callbackCount, 0, 'manual wait should suppress the nowait completion callback')
  })

  await runCase('waitForTask clears finish callback suppression when user skips manual wait', async () => {
    const backend = new FakeCommandBackend('unix', {
      os: 'linux',
      platform: 'linux',
      release: '6.8.0',
      arch: 'x64',
      hostname: 'ubuntu',
      isRemote: false,
      shell: '/bin/bash'
    })
    const service = createService(backend)

    await service.createTerminal({
      type: 'local',
      id: 'unix-nowait-suppression-cleared',
      title: 'Unix Nowait Suppression Cleared',
      cols: 120,
      rows: 32
    })

    let callbackCount = 0
    let callbackTaskId = ''
    const taskId = await service.runCommandNoWait('unix-nowait-suppression-cleared', 'printf cleared', (result) => {
      callbackCount += 1
      callbackTaskId = result.history_command_match_id
    })
    const skipped = await service.waitForTask('unix-nowait-suppression-cleared', taskId, {
      suppressFinishCallback: true,
      shouldSkip: () => true
    })

    assertEqual(skipped.exitCode, -3, 'manual wait should switch to async when skipped')
    backend.emitData('unix-nowait-suppression-cleared', `cleared${WINDOWS_OSC_PRECMD}\n`)
    await waitUntil(
      () => callbackCount === 1,
      'nowait completion callback should fire after skipped manual wait'
    )
    assertEqual(callbackTaskId, taskId, 'completion callback should preserve the command task id')
  })
}

void run().catch((error) => {
  console.error(error)
  process.exit(1)
})
