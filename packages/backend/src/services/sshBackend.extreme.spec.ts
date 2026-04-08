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
  await runCase('windows regular init script keeps the existing OSC prompt path for supported builds', async () => {
    const backend = new SSHBackend()
    const encoded = (backend as any).buildWindowsPowerShellEncodedCommand({
      commandTrackingMode: 'shell-integration'
    }) as string
    const decoded = Buffer.from(encoded, 'base64').toString('utf16le')

    assertCondition(
      decoded.includes('Write-Host -NoNewline "$([char]27)]1337;gyshell_precmd;ec=$ec;cwd_b64=$cwd_b64;home_b64=$home_b64$([char]7)"'),
      'windows init script should emit the precmd marker directly via Write-Host'
    )
    assertCondition(
      !decoded.includes('__GYSHELL_TASK_FINISH__::ec=$ec'),
      'windows init script should avoid visible finish markers that skew the rendered cursor position'
    )
    assertCondition(
      decoded.includes(';"PS $($PWD.Path)> "};'),
      'windows init script should keep the visible prompt text separate from the OSC marker'
    )
    assertCondition(
      !decoded.includes('return "$oscPS $($PWD.Path)> "'),
      'windows init script should not smuggle the OSC marker through the prompt return value'
    )
    assertCondition(
      !decoded.includes('\n'),
      'windows init script should stay minified to avoid slow cmd-shell echo during SSH bootstrap'
    )
  })

  await runCase('windows sidecar init script writes prompt markers to a hidden file for downlevel builds only', async () => {
    const backend = new SSHBackend()
    const encoded = (backend as any).buildWindowsPowerShellEncodedCommand({
      commandTrackingMode: 'windows-powershell-sidecar',
      promptMarkerPath: 'C:/Windows/Temp/GyShell/prompt-markers/gyshell-prompt-ssh-1.log',
      commandRequestPath: 'C:/Windows/Temp/GyShell/prompt-markers/exec-request.b64',
      commandOutputPath: 'C:/Windows/Temp/GyShell/prompt-markers/exec-output.txt'
    }) as string
    const decoded = Buffer.from(encoded, 'base64').toString('utf16le')

    assertCondition(
      decoded.includes('[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($global:__gyshell_marker_path))|Out-Null'),
      'sidecar init should ensure the temp marker directory exists before writing the hidden file'
    )
    assertCondition(
      decoded.includes("[IO.File]::WriteAllText($global:__gyshell_marker_path,'',$__gyshell_utf8)"),
      'sidecar init should truncate the hidden marker file before first prompt'
    )
    assertCondition(
      decoded.includes("[IO.File]::WriteAllText($global:__gyshell_marker_path,$__line+[Environment]::NewLine,$__gyshell_utf8)"),
      'sidecar init should overwrite the hidden marker file with the latest prompt state instead of printing it'
    )
    assertCondition(
      decoded.includes("[IO.File]::WriteAllText($global:__gyshell_request_path,'',$__gyshell_utf8)"),
      'sidecar init should initialize the hidden command request file for prompt-file dispatch'
    )
    assertCondition(
      decoded.includes("[IO.File]::WriteAllText($global:__gyshell_output_path,'',$__gyshell_utf8)"),
      'sidecar init should initialize the hidden command output file for prompt-file dispatch'
    )
    assertCondition(
      decoded.includes(". ([scriptblock]::Create($__gyshell_cmd)) *> $__gyshell_capture_path"),
      'sidecar init should execute hidden request-file commands inside the existing PowerShell session and redirect all rendered output into the hidden capture file'
    )
    assertCondition(
      decoded.includes("Get-Content -LiteralPath $__gyshell_capture_path -Raw -ErrorAction SilentlyContinue"),
      'sidecar init should normalize the hidden capture file back into the UTF-8 sidecar output file after execution'
    )
    assertCondition(
      decoded.includes('$global:__gyshell_last_error_count=@($Error).Count'),
      'sidecar init should track PowerShell error state without mutating LASTEXITCODE'
    )
    assertCondition(
      !decoded.includes('$global:LASTEXITCODE=0'),
      'sidecar init should preserve the user-visible LASTEXITCODE variable'
    )
    assertCondition(
      !decoded.includes('__GYSHELL_TASK_FINISH__::ec=$ec'),
      'sidecar init should not emit the visible task-finish marker in the terminal stream'
    )
    assertCondition(
      decoded.includes("'PS '+$PWD.Path+'> '"),
      'sidecar init should preserve the standard PowerShell prompt text'
    )
  })

  await runCase('windows sidecar mode only activates for downlevel powershell sessions with sftp available', async () => {
    const backend = new SSHBackend()

    const sidecarSession = createSession()
    sidecarSession.sftp = {} as any
    sidecarSession.sshConfig = { id: 'ssh-2016' } as any
    sidecarSession.systemInfo = { shell: 'powershell.exe' }
    sidecarSession.windowsBuildNumber = 14393
    assertEqual(
      (backend as any).shouldUseWindowsPowerShellSidecar(sidecarSession),
      true,
      'downlevel Windows PowerShell should opt into the sidecar route'
    )

    const modernSession = createSession()
    modernSession.sftp = {} as any
    modernSession.sshConfig = { id: 'ssh-2022' } as any
    modernSession.systemInfo = { shell: 'powershell.exe' }
    modernSession.windowsBuildNumber = 17763
    assertEqual(
      (backend as any).shouldUseWindowsPowerShellSidecar(modernSession),
      false,
      'supported Windows builds should stay on the normal shell integration path'
    )

    const noSftpSession = createSession()
    noSftpSession.systemInfo = { shell: 'powershell.exe' }
    noSftpSession.windowsBuildNumber = 14393
    noSftpSession.sftpInitError = 'unavailable'
    assertEqual(
      (backend as any).shouldUseWindowsPowerShellSidecar(noSftpSession),
      false,
      'the sidecar route should stay disabled when the hidden marker channel is unavailable'
    )
  })

  await runCase('prepareCommandTracking falls back to cached marker state when the read path fails', async () => {
    const backend = new SSHBackend() as any
    const session = createSession()
    session.commandTrackingMode = 'windows-powershell-sidecar'
    session.windowsPromptMarkerState = { sequence: 7, exitCode: 0 }
    session.windowsCommandRequestPath = 'C:/Windows/Temp/GyShell/prompt-markers/exec-request.b64'
    backend.sessions.set('pty-prepare-fallback', session)
    backend.refreshWindowsPromptMarkerState = async () => {
      throw new Error('temporary sftp failure')
    }

    const token = await backend.prepareCommandTracking('pty-prepare-fallback')

    assertEqual(
      token?.baselineSequence,
      7,
      'prepare should degrade to the cached prompt marker state instead of blocking command dispatch'
    )
    assertEqual(
      token?.awaitingInitialFreshMarker,
      true,
      'cached SSH marker baselines should still require a fresh post-dispatch marker'
    )
    assertEqual(
      token?.commandRequestPath,
      session.windowsCommandRequestPath,
      'sidecar SSH tokens should carry the hidden command request path'
    )
    assertEqual(
      token?.commandOutputPath,
      session.windowsCommandOutputPath,
      'sidecar SSH tokens should carry the hidden command output path'
    )
  })

  await runCase('prepareCommandTracking marks the token as awaiting a fresh marker when no baseline could be read', async () => {
    const backend = new SSHBackend() as any
    const session = createSession()
    session.commandTrackingMode = 'windows-powershell-sidecar'
    session.windowsCommandRequestPath = 'C:/Windows/Temp/GyShell/prompt-markers/exec-request.b64'
    session.windowsCommandOutputPath = 'C:/Windows/Temp/GyShell/prompt-markers/exec-output.txt'
    backend.sessions.set('pty-await-fresh', session)
    backend.refreshWindowsPromptMarkerState = async () => {
      throw new Error('temporary sftp failure')
    }

    const token = await backend.prepareCommandTracking('pty-await-fresh')

    assertEqual(token?.baselineSequence, 0, 'missing marker baselines should start from sequence zero')
    assertEqual(
      token?.awaitingInitialFreshMarker,
      true,
      'missing marker baselines should require a fresh post-dispatch marker before completion'
    )
    assertEqual(token?.dispatchMode, 'prompt-file', 'sidecar SSH tokens should opt into prompt-file dispatch')
    assertEqual(
      token?.displayMode,
      'synthetic-transcript',
      'downlevel SSH prompt-file dispatch should opt into synthetic transcript rendering'
    )
    assertEqual(
      token?.commandOutputPath,
      session.windowsCommandOutputPath,
      'downlevel SSH prompt-file dispatch should carry the hidden output file path'
    )
  })

  await runCase('prepareCommandTracking clears the remote marker file when no baseline could be read', async () => {
    const backend = new SSHBackend() as any
    const session = createSession()
    session.commandTrackingMode = 'windows-powershell-sidecar'
    session.windowsPromptMarkerPath = 'C:/Windows/Temp/GyShell/prompt-markers/gyshell-prompt-ssh-reset.log'
    backend.sessions.set('pty-reset-marker', session)
    backend.refreshWindowsPromptMarkerState = async () => null
    backend.resetWindowsPromptMarker = async (current: unknown) => {
      assertEqual(current, session, 'prepare should reset the marker file on the active SSH session')
      return true
    }

    const token = await backend.prepareCommandTracking('pty-reset-marker')

    assertEqual(token?.baselineSequence, 0, 'marker resets should restart the sequence baseline')
    assertEqual(
      token?.awaitingInitialFreshMarker,
      false,
      'successful marker resets should avoid the extra fresh-marker wait path'
    )
  })

  await runCase('pollCommandTracking falls back to exec-based marker reads when SFTP marker reads fail', async () => {
    const backend = new SSHBackend() as any
    const session = createSession()
    session.client = {}
    session.commandTrackingMode = 'windows-powershell-sidecar'
    session.windowsCommandOutputPath = 'C:/Windows/Temp/GyShell/prompt-markers/exec-output.txt'
    backend.sessions.set('pty-poll-fallback', session)
    backend.readWindowsPromptMarkerState = async () => {
      throw Object.assign(new Error('sftp channel reset'), { code: 'EIO' })
    }
    backend.readWindowsPromptMarkerStateViaExec = async () => ({
      sequence: 5,
      exitCode: 0,
      cwd: 'C:/Windows',
      homeDir: 'C:/Users/Administrator'
    })
    backend.readWindowsCommandOutputViaExec = async () => 'fallback-output\r\n'

    const update = await backend.pollCommandTracking('pty-poll-fallback', {
      mode: 'windows-powershell-sidecar',
      baselineSequence: 4,
      commandOutputPath: session.windowsCommandOutputPath
    })

    assertEqual(update?.sequence, 5, 'poll should still complete through the exec fallback path')
    assertEqual(update?.cwd, 'C:/Windows', 'poll fallback should preserve cwd updates')
    assertEqual(update?.output, 'fallback-output\r\n', 'poll fallback should also recover the hidden rendered output')
  })

  await runCase('pollCommandTracking ignores stale prompt markers until a fresh post-dispatch marker arrives', async () => {
    const backend = new SSHBackend() as any
    const session = createSession()
    session.commandTrackingMode = 'windows-powershell-sidecar'
    backend.sessions.set('pty-stale-marker', session)

    const snapshots = [
      {
        sequence: 1,
        exitCode: 0,
        cwd: 'C:/Users/Administrator',
        homeDir: 'C:/Users/Administrator',
        modifiedAtMs: 1000
      },
      {
        sequence: 2,
        exitCode: 0,
        cwd: 'C:/Windows',
        homeDir: 'C:/Users/Administrator',
        modifiedAtMs: 3000
      }
    ]
    backend.refreshWindowsPromptMarkerState = async () => {
      throw new Error('stale freshness checks should not rely on the low-resolution sftp path')
    }
    backend.refreshWindowsPromptMarkerStateViaExec = async () => snapshots.shift() || null

    const token = {
      mode: 'windows-powershell-sidecar',
      baselineSequence: 0,
      awaitingInitialFreshMarker: true,
      dispatchedAtMs: 2000
    } as any

    const stale = await backend.pollCommandTracking('pty-stale-marker', token)
    const fresh = await backend.pollCommandTracking('pty-stale-marker', token)

    assertEqual(stale, undefined, 'the pre-dispatch prompt marker should only refresh the baseline')
    assertEqual(token.baselineSequence, 1, 'stale prompt markers should advance the baseline sequence')
    assertEqual(fresh?.sequence, 2, 'the first post-dispatch prompt marker should finish the command')
  })

  await runCase('pollCommandTracking uses exec-based marker reads for same-second fresh-marker checks', async () => {
    const backend = new SSHBackend() as any
    const session = createSession()
    session.commandTrackingMode = 'windows-powershell-sidecar'
    backend.sessions.set('pty-highres-marker', session)
    backend.refreshWindowsPromptMarkerState = async () => {
      throw new Error('same-second freshness checks should bypass the sftp marker path')
    }
    backend.refreshWindowsPromptMarkerStateViaExec = async () => ({
      sequence: 3,
      exitCode: 0,
      cwd: 'C:/Windows',
      homeDir: 'C:/Users/Administrator',
      modifiedAtMs: 2500
    })

    const token = {
      mode: 'windows-powershell-sidecar',
      baselineSequence: 0,
      awaitingInitialFreshMarker: true,
      dispatchedAtMs: 2000
    } as any

    const update = await backend.pollCommandTracking('pty-highres-marker', token)

    assertEqual(update?.sequence, 3, 'exec-based marker reads should accept fresh same-second completions')
    assertEqual(token.awaitingInitialFreshMarker, false, 'fresh exec-based markers should clear the wait flag')
  })

  await runCase('windows marker cleanup removes the current temp file and clears cached tracking state', async () => {
    const backend = new SSHBackend() as any
    const removedPaths: string[] = []
    const removedDirs: string[] = []
    const session = createSession()
    session.sftp = {} as any
    session.windowsPromptMarkerPath = 'C:/Windows/Temp/GyShell/prompt-markers/gyshell-prompt-ssh-clean.log'
    session.windowsCommandOutputPath = 'C:/Windows/Temp/GyShell/prompt-markers/gyshell-output-ssh-clean.txt'
    session.windowsPromptMarkerState = { sequence: 4, exitCode: 0 }

    backend.sftpUnlink = async (_sftp: unknown, normalizedPath: string) => {
      removedPaths.push(normalizedPath)
    }
    backend.sftpRmdir = async (_sftp: unknown, normalizedPath: string) => {
      removedDirs.push(normalizedPath)
    }

    await backend.cleanupWindowsPromptMarker(session)

    assertEqual(
      removedPaths[0],
      'C:/Windows/Temp/GyShell/prompt-markers/gyshell-prompt-ssh-clean.log',
      'cleanup should unlink the current marker file from the temp marker directory'
    )
    assertEqual(
      removedPaths[1],
      'C:/Windows/Temp/GyShell/prompt-markers/gyshell-output-ssh-clean.txt',
      'cleanup should unlink the hidden output file from the temp marker directory'
    )
    assertEqual(
      removedDirs[0],
      'C:/Windows/Temp/GyShell/prompt-markers',
      'cleanup should try to remove the prompt-marker temp directory when it becomes empty'
    )
    assertEqual(
      removedDirs[1],
      'C:/Windows/Temp/GyShell',
      'cleanup should also try to prune the parent GyShell temp directory when empty'
    )
    assertEqual(session.windowsPromptMarkerPath, undefined, 'cleanup should clear the marker path from the session')
    assertEqual(session.windowsCommandOutputPath, undefined, 'cleanup should clear the output path from the session')
    assertEqual(session.windowsPromptMarkerState, undefined, 'cleanup should clear cached marker state')
  })

  await runCase('windows shell bootstrap waits longer before retrying', async () => {
    const backend = new SSHBackend() as any
    assertEqual(
      backend.getShellInitRetryIntervalMs('windows'),
      20000,
      'windows bootstrap should tolerate slow cmd-shell replay before retrying'
    )
    assertEqual(
      backend.getShellInitRetryIntervalMs('unix'),
      8000,
      'unix bootstrap should keep the existing faster retry cadence'
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
