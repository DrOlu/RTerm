import { SSHBackend } from './SSHBackend'
import { EventEmitter } from 'node:events'

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(`${message}. expected=${String(expected)} actual=${String(actual)}`)
  }
}

const assertCondition = (condition: unknown, message: string): void => {
  if (!condition) {
    throw new Error(message)
  }
}

const runCase = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
  await fn()
  console.log(`PASS ${name}`)
}

const createSession = () =>
  ({
    client: {},
    dataCallbacks: new Set(),
    exitCallbacks: new Set(),
    isInitializing: true,
    buffer: '',
    oscBuffer: '',
    forwardServers: [],
    remoteForwards: [],
    remoteForwardHandlerInstalled: false,
    initializationState: 'initializing',
  }) as any

const run = async (): Promise<void> => {
  await runCase('windows init script emits the OSC marker via Write-Host instead of the prompt return value', async () => {
    const backend = new SSHBackend()
    const encoded = (backend as any).buildWindowsPowerShellEncodedCommand() as string
    const decoded = Buffer.from(encoded, 'base64').toString('utf16le')

    assertCondition(
      decoded.includes('Write-Host -NoNewline "$([char]27)]1337;gyshell_precmd;ec=$ec;cwd_b64=$cwd_b64;home_b64=$home_b64$([char]7)"'),
      'windows init script should emit the precmd marker directly via Write-Host'
    )
    assertCondition(
      decoded.includes('return "PS $($PWD.Path)> "'),
      'windows init script should keep the visible prompt text separate from the OSC marker'
    )
    assertCondition(
      !decoded.includes('return "$oscPS $($PWD.Path)> "'),
      'windows init script should not smuggle the OSC marker through the prompt return value'
    )
  })

  await runCase('getSystemInfo schedules a backend retry when remote os is not ready yet', async () => {
    const backend = new SSHBackend()
    const session = createSession()
    ;(backend as any).sessions.set('pty-a', session)
    const originalSetTimeout = globalThis.setTimeout
    const originalClearTimeout = globalThis.clearTimeout
    const scheduled: Array<() => void> = []

    ;(globalThis as any).setTimeout = (callback: () => void) => {
      scheduled.push(callback)
      return { fake: true } as any
    }
    ;(globalThis as any).clearTimeout = () => {}

    let remoteOs: 'windows' | undefined
    let execCallCount = 0
    ;(backend as any).waitForRemoteOs = async () => remoteOs
    ;(backend as any).execCollect = async () => {
      execCallCount += 1
      return {
        stdout: JSON.stringify({
          Version: '10.0.26200',
          CSName: 'QUIET-HOST',
          Arch: 'x64',
        }),
        stderr: '',
      }
    }

    try {
      const info = await backend.getSystemInfo('pty-a')

      assertEqual(info, undefined, 'system info should stay undefined while remote os is unresolved')
      assertEqual(session.systemInfo, undefined, 'unresolved system info should not be cached')
      assertEqual(scheduled.length, 1, 'backend should schedule an independent retry after a miss')

      remoteOs = 'windows'
      scheduled[0]?.()
      await Promise.resolve()
      await Promise.resolve()

      assertEqual(execCallCount, 1, 'scheduled retry should probe system info without more terminal output')
      assertEqual(session.systemInfo?.hostname, 'QUIET-HOST', 'scheduled retry should eventually populate system info')
    } finally {
      ;(globalThis as any).setTimeout = originalSetTimeout
      ;(globalThis as any).clearTimeout = originalClearTimeout
    }
  })

  await runCase('getSystemInfo retries after a temporary windows collection failure', async () => {
    const backend = new SSHBackend()
    const session = createSession()
    session.initializationState = 'ready'
    session.remoteOs = 'windows'
    ;(backend as any).sessions.set('pty-b', session)

    let callCount = 0
    ;(backend as any).execCollect = async () => {
      callCount += 1
      if (callCount === 1) {
        throw new Error('temporary failure')
      }
      return {
        stdout: JSON.stringify({
          Version: '10.0.26200',
          CSName: 'TUOTUO-SERVER',
          Arch: 'x64',
        }),
        stderr: '',
      }
    }

    const first = await backend.getSystemInfo('pty-b')
    const second = await backend.getSystemInfo('pty-b')

    assertEqual(first, undefined, 'failed collections should not cache fallback unknown data')
    assertCondition(second !== undefined, 'subsequent calls should retry and return real system info')
    assertEqual(second.hostname, 'TUOTUO-SERVER', 'retried collection should parse hostname')
    assertEqual(session.systemInfo?.hostname, 'TUOTUO-SERVER', 'successful retry should populate the cache')
  })

  await runCase('execOnSession writes stdin payloads to the SSH exec channel', async () => {
    class FakeStream extends EventEmitter {
      readonly stderr = new EventEmitter()
      endPayload: string | undefined

      end(input?: string): this {
        this.endPayload = input
        this.emit('data', Buffer.from('monitor-json'))
        this.emit('close')
        return this
      }
    }

    const backend = new SSHBackend()
    const stream = new FakeStream()
    let observedCommand = ''
    const session = createSession()
    session.client = {
      exec: (command: string, callback: (err: Error | null, stream: FakeStream) => void) => {
        observedCommand = command
        callback(null, stream)
      },
    }
    ;(backend as any).sessions.set('pty-c', session)

    const result = await backend.execOnSession(
      'pty-c',
      'powershell.exe -NoLogo -NoProfile -NonInteractive -Command -',
      1000,
      { stdin: 'Write-Output 123\n' }
    )

    assertEqual(
      observedCommand,
      'powershell.exe -NoLogo -NoProfile -NonInteractive -Command -',
      'ssh exec should preserve the requested command verbatim'
    )
    assertEqual(
      stream.endPayload,
      'Write-Output 123\n',
      'ssh exec should stream stdin payloads to the remote process'
    )
    assertEqual(
      result?.stdout,
      'monitor-json',
      'ssh exec should still collect stdout when stdin is used'
    )
  })
}

void run().catch((error) => {
  console.error(error)
  process.exit(1)
})
