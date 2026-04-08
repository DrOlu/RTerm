import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { NodePtyBackend } from './NodePtyBackend'

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

const run = async (): Promise<void> => {
  await runCase('downlevel local windows powershell sessions switch to hidden sidecar tracking', async () => {
    const backend = new NodePtyBackend()
    const tracking = (backend as any).resolveWindowsShellTracking('powershell.exe', '10.0.14393')
    const encoded = (backend as any).buildWindowsPowerShellEncodedCommand(
      tracking.commandTrackingMode,
      tracking.promptMarkerPath,
      tracking.commandRequestPath,
      tracking.commandOutputPath
    ) as string
    const decoded = Buffer.from(encoded, 'base64').toString('utf16le')

    assertEqual(
      tracking.commandTrackingMode,
      'windows-powershell-sidecar',
      'downlevel local windows powershell should use the sidecar route'
    )
    assertCondition(
      typeof tracking.tmpPath === 'string' && tracking.tmpPath.length > 0,
      'downlevel sidecar mode should allocate a temp directory for marker storage'
    )
    assertCondition(
      typeof tracking.promptMarkerPath === 'string' && tracking.promptMarkerPath.startsWith(tracking.tmpPath),
      'prompt marker file should live inside the temp directory'
    )
    assertCondition(
      typeof tracking.commandRequestPath === 'string' && tracking.commandRequestPath.startsWith(tracking.tmpPath),
      'prompt-file dispatch should store its hidden command request file inside the same temp directory'
    )
    assertCondition(
      typeof tracking.commandOutputPath === 'string' && tracking.commandOutputPath.startsWith(tracking.tmpPath),
      'prompt-file dispatch should store its hidden command output file inside the same temp directory'
    )
    assertCondition(
      decoded.includes("[IO.File]::WriteAllText($global:__gyshell_marker_path,$__line+[Environment]::NewLine,$__gyshell_utf8)"),
      'local sidecar prompt should keep only the latest marker line in the temp file'
    )
    assertCondition(
      decoded.includes("[IO.File]::WriteAllText($global:__gyshell_output_path,'',$__gyshell_utf8)"),
      'local sidecar prompt should initialize the hidden output file inside the temp directory'
    )
    assertCondition(
      decoded.includes(". ([scriptblock]::Create($__gyshell_cmd)) *> $__gyshell_capture_path"),
      'local sidecar prompt should execute hidden request-file commands inside the live PowerShell session and redirect all rendered output into the hidden capture file'
    )
    assertCondition(
      decoded.includes("Get-Content -LiteralPath $__gyshell_capture_path -Raw -ErrorAction SilentlyContinue"),
      'local sidecar prompt should normalize the hidden capture file back into the UTF-8 sidecar output file after execution'
    )
    assertCondition(
      !decoded.includes('$global:LASTEXITCODE=0'),
      'local sidecar prompt should preserve the shell-visible LASTEXITCODE variable'
    )
    assertCondition(
      !decoded.includes('__GYSHELL_TASK_FINISH__::ec=$ec'),
      'local sidecar prompt should not print visible finish markers'
    )

    fs.rmSync(tracking.tmpPath, { recursive: true, force: true })
  })

  await runCase('supported local windows powershell sessions stay on shell integration', async () => {
    const backend = new NodePtyBackend()
    const tracking = (backend as any).resolveWindowsShellTracking('powershell.exe', '10.0.17763')
    const encoded = (backend as any).buildWindowsPowerShellEncodedCommand(
      tracking.commandTrackingMode,
      tracking.promptMarkerPath
    ) as string
    const decoded = Buffer.from(encoded, 'base64').toString('utf16le')

    assertEqual(
      tracking.commandTrackingMode,
      'shell-integration',
      'supported local windows builds should not switch to the sidecar route'
    )
    assertEqual(tracking.tmpPath, undefined, 'modern windows builds should not create a temp sidecar directory')
    assertCondition(
      decoded.includes('Write-Host -NoNewline "$([char]27)]1337;gyshell_precmd;ec=$ec;cwd_b64=$cwd_b64;home_b64=$home_b64$([char]7)"'),
      'modern windows builds should keep the zero-width OSC shell integration marker'
    )
    assertCondition(
      !decoded.includes('__GYSHELL_TASK_FINISH__::ec=$ec'),
      'modern windows builds should avoid visible finish markers that shift the prompt geometry'
    )
  })

  await runCase('cleanupTempArtifacts removes local sidecar temp directories and tracking state', async () => {
    const backend = new NodePtyBackend() as any
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gyshell-nodepty-cleanup-'))
    const markerPath = path.join(tmpDir, 'prompt-marker.log')
    fs.writeFileSync(markerPath, 'marker\n', 'utf8')

    backend.tmpPathsByPtyId.set('pty-clean', tmpDir)
    backend.promptMarkerPathByPtyId.set('pty-clean', markerPath)
    backend.commandRequestPathByPtyId.set('pty-clean', path.join(tmpDir, 'exec-request.b64'))
    backend.commandOutputPathByPtyId.set('pty-clean', path.join(tmpDir, 'exec-output.txt'))
    backend.commandTrackingModeByPtyId.set('pty-clean', 'windows-powershell-sidecar')
    backend.promptMarkerStateByPtyId.set('pty-clean', { sequence: 1, exitCode: 0 })

    backend.cleanupTempArtifacts('pty-clean')

    assertEqual(fs.existsSync(tmpDir), false, 'cleanup should remove the temp directory recursively')
    assertEqual(backend.promptMarkerPathByPtyId.has('pty-clean'), false, 'cleanup should clear prompt marker state')
    assertEqual(backend.commandRequestPathByPtyId.has('pty-clean'), false, 'cleanup should clear request-file tracking state')
    assertEqual(backend.commandOutputPathByPtyId.has('pty-clean'), false, 'cleanup should clear output-file tracking state')
    assertEqual(backend.commandTrackingModeByPtyId.has('pty-clean'), false, 'cleanup should clear command tracking mode')
    assertEqual(backend.promptMarkerStateByPtyId.has('pty-clean'), false, 'cleanup should clear cached marker data')
  })

  await runCase('prepareCommandTracking waits for a fresh marker when no local baseline was readable', async () => {
    const backend = new NodePtyBackend() as any
    backend.commandTrackingModeByPtyId.set('pty-await-fresh', 'windows-powershell-sidecar')
    backend.commandRequestPathByPtyId.set('pty-await-fresh', 'C:/Temp/exec-request.b64')
    backend.commandOutputPathByPtyId.set('pty-await-fresh', 'C:/Temp/exec-output.txt')
    backend.refreshPromptMarkerState = async () => null

    const token = await backend.prepareCommandTracking('pty-await-fresh')

    assertEqual(token?.baselineSequence, 0, 'missing local baselines should start from sequence zero')
    assertEqual(
      token?.awaitingInitialFreshMarker,
      true,
      'missing local baselines should require a fresh post-dispatch marker before completion'
    )
    assertEqual(token?.dispatchMode, 'prompt-file', 'local sidecar tokens should opt into prompt-file dispatch')
    assertEqual(
      token?.displayMode,
      'synthetic-transcript',
      'downlevel local prompt-file dispatch should opt into synthetic transcript rendering'
    )
    assertEqual(
      token?.commandOutputPath,
      'C:/Temp/exec-output.txt',
      'local sidecar tokens should carry the hidden output file path'
    )
  })

  await runCase('prepareCommandTracking requires a fresh marker when it reuses cached local state', async () => {
    const backend = new NodePtyBackend() as any
    backend.commandTrackingModeByPtyId.set('pty-cached-local', 'windows-powershell-sidecar')
    backend.promptMarkerStateByPtyId.set('pty-cached-local', { sequence: 9, exitCode: 0 })
    backend.refreshPromptMarkerState = async () => null

    const token = await backend.prepareCommandTracking('pty-cached-local')

    assertEqual(token?.baselineSequence, 9, 'cached local marker state should still seed the baseline sequence')
    assertEqual(
      token?.awaitingInitialFreshMarker,
      true,
      'cached local baselines should wait for a fresh post-dispatch marker before completion'
    )
  })

  await runCase('pollCommandTracking ignores stale local prompt markers until a fresh marker arrives', async () => {
    const backend = new NodePtyBackend() as any
    backend.commandTrackingModeByPtyId.set('pty-stale-local', 'windows-powershell-sidecar')
    const snapshots = [
      {
        sequence: 4,
        exitCode: 0,
        cwd: 'C:/Users/Administrator',
        homeDir: 'C:/Users/Administrator',
        modifiedAtMs: 1000
      },
      {
        sequence: 5,
        exitCode: 0,
        cwd: 'C:/Windows',
        homeDir: 'C:/Users/Administrator',
        modifiedAtMs: 3000
      }
    ]
    backend.refreshPromptMarkerState = async () => snapshots.shift() || null

    const token = {
      mode: 'windows-powershell-sidecar',
      baselineSequence: 0,
      awaitingInitialFreshMarker: true,
      dispatchedAtMs: 2000
    } as any

    const stale = await backend.pollCommandTracking('pty-stale-local', token)
    const fresh = await backend.pollCommandTracking('pty-stale-local', token)

    assertEqual(stale, undefined, 'the pre-dispatch local prompt marker should only refresh the baseline')
    assertEqual(token.baselineSequence, 4, 'stale local markers should advance the baseline sequence')
    assertEqual(fresh?.sequence, 5, 'the first post-dispatch local marker should finish the command')
  })

  await runCase('cleanupStaleWindowsSidecarTempDirs prunes abandoned temp directories from old runs', async () => {
    const backend = new NodePtyBackend() as any
    const staleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gyshell-winps-stale-'))
    const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gyshell-winps-fresh-'))
    const staleTime = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)

    fs.utimesSync(staleDir, staleTime, staleTime)
    backend.hasScannedWindowsSidecarTempDirs = false
    backend.cleanupStaleWindowsSidecarTempDirs()

    assertEqual(fs.existsSync(staleDir), false, 'stale sidecar temp directories should be removed')
    assertEqual(fs.existsSync(freshDir), true, 'recent sidecar temp directories should be kept')

    fs.rmSync(freshDir, { recursive: true, force: true })
  })

  await runCase('execOnSession passes stdin to child process via spawn', async () => {
    const backend = new NodePtyBackend()
    // Use /bin/sh on unix, powershell on win — the standard invocation reads from stdin with "cat" / "-Command -"
    const isWin = os.platform() === 'win32'
    const command = isWin ? '-' : 'cat'
    // Build a minimal stdin payload that produces deterministic output
    const payload = isWin ? "Write-Output 'STDIN_OK'\r\n" : 'echo STDIN_OK\n'

    // We call execOnSession with stdin — prior to the fix this would be silently ignored
    const result = await backend.execOnSession('test-stdin', command, 5000, { stdin: payload })

    assertCondition(result !== null, 'execOnSession with stdin should not return null')
    assertCondition(
      result!.stdout.includes('STDIN_OK'),
      `stdout should contain the text written via stdin, got: ${JSON.stringify(result!.stdout.slice(0, 200))}`
    )
  })

  await runCase('execOnSession without stdin still works via execFile path', async () => {
    const backend = new NodePtyBackend()
    const isWin = os.platform() === 'win32'
    const command = isWin ? "Write-Output 'NO_STDIN'" : "echo NO_STDIN"

    const result = await backend.execOnSession('test-no-stdin', command, 5000)

    assertCondition(result !== null, 'execOnSession without stdin should still work')
    assertCondition(
      result!.stdout.includes('NO_STDIN'),
      `stdout should contain echo output, got: ${JSON.stringify(result!.stdout.slice(0, 200))}`
    )
  })

  await runCase('execOnSession with stdin returns null on timeout instead of hanging', async () => {
    const backend = new NodePtyBackend()
    const isWin = os.platform() === 'win32'
    // A command that blocks forever reading stdin — we send no stdin terminator
    const command = isWin ? '-' : 'cat'

    // Use a very short timeout to verify it doesn't hang
    const result = await backend.execOnSession(
      'test-stdin-timeout',
      command,
      500,
      { stdin: '' }  // empty stdin but the command expects more — should timeout
    )

    // On some systems the empty stdin causes immediate EOF and cat exits.
    // Either null (timeout) or empty output are acceptable — the key test is it doesn't hang.
    assertCondition(
      result === null || result.stdout.length === 0,
      'timed-out or empty stdin should not produce unexpected output'
    )
  })

  await runCase('execOnSession with stdin handles large payloads', async () => {
    const backend = new NodePtyBackend()
    const isWin = os.platform() === 'win32'
    // Simulate the ~6KB PowerShell monitor script size
    const marker = 'LARGE_PAYLOAD_OK'
    const padding = 'x'.repeat(6000)
    const command = isWin ? '-' : 'cat'
    const payload = isWin
      ? `$null='${padding}'; Write-Output '${marker}'\r\n`
      : `# ${padding}\necho ${marker}\n`

    const result = await backend.execOnSession('test-large-stdin', command, 10000, { stdin: payload })

    assertCondition(result !== null, 'large stdin payload should not cause failure')
    assertCondition(
      result!.stdout.includes(marker),
      `large stdin payload should produce expected output, got: ${JSON.stringify(result!.stdout.slice(0, 200))}`
    )
  })
}

void run().catch((error) => {
  console.error(error)
  process.exit(1)
})
