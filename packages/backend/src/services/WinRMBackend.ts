import { randomUUID } from 'node:crypto'
import type {
  TerminalConfig,
  WinRMConnectionConfig,
  TerminalSystemInfo,
  TerminalBackend,
} from '../types'
import { WinRMTransport } from './WinRMTransport'
import { PSRPTransport } from './PSRPTransport'

/**
 * WinRM (Windows Remote Management) terminal backend.
 *
 * Scope (v1): command execution + the fleet tools, rendered as a
 * command/response log — NOT a full interactive PTY. WinRM's WS-Management
 * shell model is request/response: each `exec_command` / `run_fleet_command`
 * / `collect_facts` runs as a stateless create-shell → run → receive →
 * delete cycle via `WinRMTransport.runCommand`. There is no streaming stdin,
 * no `write` to a live PTY, and no shell-integration marker tracking.
 *
 * The backend implements the optional `executeCommand` hook so
 * TerminalService routes command execution through it directly instead of the
 * stream-write + marker-tracking path used by SSH/local PTY backends.
 */

interface WinRMInstance {
  config: WinRMConnectionConfig
  /** The active transport. WinRM and PSRP expose different execution APIs —
   * use the type guards (`instance.psrp` / `instance.winrm`) to dispatch. */
  transport: WinRMTransport | PSRPTransport
  /** Narrowed WinRM transport (set when transport is WinRMTransport). */
  winrm?: WinRMTransport
  /** Narrowed PSRP transport (set when transport is PSRPTransport). */
  psrp?: PSRPTransport
  dataCallback?: (data: string) => void
  exitCallback?: (code: number) => void
  /** Set once spawn's connectivity probe finishes; the tab is ready then. */
  ready: boolean
  /** Set if spawn's probe failed; the tab is exited/unreachable. */
  failed: boolean
  /** persistent runspace (created lazily, reused across commands). */
  persistentShellId?: string
  /** serialize commands on the persistent shell (one WS-Man command per shell). */
  commandQueue: Promise<unknown>
  /** persistent cwd tracked across commands (best-effort). */
  cwd?: string
}

const DEFAULT_WINRM_TIMEOUT_MS = 120_000

export class WinRMBackend implements TerminalBackend {
  private instances = new Map<string, WinRMInstance>()
  /** ptyId → WinRMInstance, keyed by the id returned from spawn. */

  spawn(config: TerminalConfig): Promise<string> {
    if (config.type !== 'winrm') {
      throw new Error('WinRMBackend only supports winrm connections')
    }
    const cfg = config as WinRMConnectionConfig
    const ptyId = `winrm-${randomUUID()}`
    const transport = this.buildTransport(cfg)
    const instance: WinRMInstance = {
      config: cfg,
      transport,
      winrm: transport instanceof WinRMTransport ? transport : undefined,
      psrp: transport instanceof PSRPTransport ? transport : undefined,
      ready: false,
      failed: false,
      commandQueue: Promise.resolve(),
    }
    this.instances.set(ptyId, instance)

    // Verify reachability in the background so the tab flips to ready/exited
    // the same way SSH tabs do. We emit a banner via onData on success, and
    // onExit on failure (which TerminalService maps to runtimeState=exited).
    void this.probe(instance).then((ok) => {
      if (ok) {
        instance.ready = true
        const mode = cfg.transport === 'psrp'
          ? 'PSRP / PowerShell Remoting — no command-length limit'
          : 'WinRM command/response — Windows Server'
        instance.dataCallback?.(
          `\x1b[32m✔ ${cfg.transport === 'psrp' ? 'PSRP' : 'WinRM'} session ready to ${cfg.host}:${cfg.port} (${mode}).\x1b[0m\r\n` +
            `Run commands with exec_command / run_fleet_command. Interactive TUI apps are not supported over WinRM/PSRP.\r\n`,
        )
      } else {
        instance.failed = true
        instance.exitCallback?.(-1)
      }
    })

    return Promise.resolve(ptyId)
  }

  private async probe(instance: WinRMInstance): Promise<boolean> {
    try {
      await (instance.winrm ?? instance.transport).ping()
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      instance.dataCallback?.(
        `\x1b[31m✘ WinRM connection failed: ${message}\x1b[0m\r\n`,
      )
      return false
    }
  }

  private buildTransport(cfg: WinRMConnectionConfig): WinRMTransport | PSRPTransport {
    const username = cfg.domain ? `${cfg.domain}\\${cfg.username}` : cfg.username
    // PSRP: PowerShell Remoting Protocol over the same WS-Man channel — the
    // script travels inside the message body (no 8191-char command budget).
    if (cfg.transport === 'psrp') {
      return new PSRPTransport({
        host: cfg.host,
        port: cfg.port,
        username,
        password: cfg.password,
        transport: cfg.port === 5986 ? 'https' : 'http',
        rejectUnauthorized: cfg.rejectUnauthorized,
        timeoutMs: 30000,
      })
    }
    const transport =
      cfg.transport ?? (cfg.port === 5986 ? 'https' : 'http')
    return new WinRMTransport({
      host: cfg.host,
      port: cfg.port,
      username,
      password: cfg.password,
      transport,
      rejectUnauthorized: cfg.rejectUnauthorized,
      timeoutMs: 30000,
    })
  }

  /** Direct command execution — the path TerminalService uses for winrm tabs.
   * Uses a persistent runspace (reused across commands) + streams output live,
   * and tracks the working directory so `cd` persists between commands. */
  async executeCommand(
    ptyId: string,
    command: string,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const instance = this.instances.get(ptyId)
    if (!instance) {
      throw new Error(`WinRM session not found for ptyId=${ptyId}`)
    }
    if (instance.failed) {
      throw new Error('WinRM session is not connected (probe failed).')
    }
    // If the probe hasn't completed yet, wait briefly; the tab is usually ready
    // by the time the agent runs a command.
    const waited = await this.waitForReady(instance, 10000)
    if (!waited) {
      throw new Error('WinRM session is still initializing; try again shortly.')
    }

    // Serialize commands on the persistent shell (one WS-Man command per shell).
    const run = instance.commandQueue.then(() =>
      this.executeOnTransport(instance, command, options),
    )
    instance.commandQueue = run.catch(() => { /* keep the queue alive */ })
    return run
  }

  /**
   * Dispatch to the right execution path for the configured transport.
   * - WinRM (cmd shell): persistent shell + cwd tracking + cmd echo.
   * - PSRP (PowerShell runspace): each command runs as a fresh one-shot
   *   script in a real PowerShell runspace (cwd is seeded per command; the
   *   script travels in the message body — no 8191-char budget). PSRP runspaces
   *   are heavier to keep open, so v1 runs one-shot per command.
   */
  private async executeOnTransport(
    instance: WinRMInstance,
    command: string,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (instance.psrp) {
      return this.executeOnPsrp(instance, command, options)
    }
    return this.executeOnPersistentShell(instance, command, options)
  }

  /** PSRP execution path: wrap the (possibly cmd-flavored) command for
   * PowerShell, run one-shot, surface hadErrors as stderr. */
  private async executeOnPsrp(
    instance: WinRMInstance,
    command: string,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const transport = instance.psrp
    if (!transport) {
      throw new Error('PSRP execution path invoked without a PSRP transport')
    }
    // Surface the command echo to the command/response log view.
    instance.dataCallback?.(`\r\n\x1b[36m❯ ${command}\x1b[0m\r\n`)
    // PSRP runs PowerShell, not cmd: translate the common cmd builtins the
    // agent emits (cd/dir/type) so the command/response experience matches.
    const ps = this.translateCmdToPowerShell(command, instance.cwd)
    const result = await transport.runScript(ps, {
      timeoutMs: options?.timeoutMs ?? DEFAULT_WINRM_TIMEOUT_MS,
      signal: options?.signal,
    })
    if (result.stdout) instance.dataCallback?.(result.stdout)
    if (result.stderr) instance.dataCallback?.(`\x1b[33m${result.stderr}\x1b[0m`)
    // Track cwd across commands (best-effort, same contract as the WinRM path).
    if (/^\s*(Set-Location|cd)\s+/i.test(command) && !result.hadErrors) {
      const target = command.replace(/^\s*(Set-Location|cd)\s+/i, '').replace(/"/g, '').trim()
      instance.cwd = this.resolveWinCwd(instance.cwd, target)
    }
    // PSRP pipelines do not propagate a process exit code — Windows reports 0
    // in CommandState even after `exit 3` or a terminating error, and signals
    // failure via ERROR_RECORD / PIPELINE_STATE=Failed instead (that is why
    // pypsrp exposes `had_errors`, not an exit code). Map that onto the
    // exitCode contract every caller relies on (run_fleet_command, the agent's
    // exec_command, playbook validate) so a failed PowerShell command is not
    // reported as success. 1 is the conventional PowerShell failure code.
    const exitCode = result.exitCode !== 0 ? result.exitCode : result.hadErrors ? 1 : 0
    return { stdout: result.stdout, stderr: result.stderr, exitCode }
  }

  /** Translate the common cmd.exe builtins the agent emits into PowerShell
   * equivalents (PSRP runs a real PowerShell runspace, not cmd). */
  private translateCmdToPowerShell(command: string, cwd?: string): string {
    const cdPrefix = cwd ? `Set-Location -LiteralPath '${cwd.replace(/'/g, "''")}'; ` : ''
    let ps = command
    // `cd /d X` / `cd X` → Set-Location
    ps = ps.replace(/^\s*cd\s+\/d\s+/i, 'Set-Location -LiteralPath ')
    ps = ps.replace(/^\s*cd\s+/i, 'Set-Location -LiteralPath ')
    // `dir` → Get-ChildItem (bare `dir` works in PS but normalize for flags)
    ps = ps.replace(/^\s*dir\s*$/i, 'Get-ChildItem')
    // `type X` → Get-Content
    ps = ps.replace(/^\s*type\s+/i, 'Get-Content ')
    // `cls` → Clear-Host
    ps = ps.replace(/^\s*cls\s*$/i, 'Clear-Host')
    // `echo X` → Write-Output X (PS echo exists but Write-Output is explicit)
    ps = ps.replace(/^\s*echo\s+/i, 'Write-Output ')
    return cdPrefix + ps
  }

  /** Lazily create (or recreate) the persistent runspace. */
  private async ensurePersistentShell(instance: WinRMInstance): Promise<string> {
    if (instance.persistentShellId) return instance.persistentShellId
    const shellId = await instance.winrm!.createShell()
    instance.persistentShellId = shellId
    // Seed the cwd from the fresh runspace.
    try {
      const r = await instance.winrm!.runCommandOnShell(shellId, 'cd', { timeoutMs: 10000 })
      const cwd = r.stdout.trim()
      if (cwd) instance.cwd = cwd
    } catch { /* best-effort */ }
    return shellId
  }

  private async executeOnPersistentShell(
    instance: WinRMInstance,
    command: string,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    // Surface the command echo to the command/response log view.
    instance.dataCallback?.(`\r\n\x1b[36m❯ ${command}\x1b[0m\r\n`)

    let result: { stdout: string; stderr: string; exitCode: number }
    // WinRM cmd-shells do NOT persist cwd/env across Command invocations (verified
    // live). So we (a) run each command inside the tracked cwd by prepending
    // `cd /d <cwd> &`, and (b) update the tracked cwd when the user `cd`s, giving
    // an effective persistent working directory across commands.
    const cwdPrefix = instance.cwd ? `cd /d ${instance.cwd} & ` : ''
    const isCd = /^\s*(cd|chdir)\s+/i.test(command)
    try {
      const shellId = await this.ensurePersistentShell(instance)
      result = await instance.winrm!.runCommandOnShell(shellId, cwdPrefix + command, {
        timeoutMs: options?.timeoutMs ?? DEFAULT_WINRM_TIMEOUT_MS,
        signal: options?.signal,
        onChunk: (stream, text) => {
          // Stream output live to the tab instead of buffering it all.
          if (text) instance.dataCallback?.(stream === 'stderr' ? `\x1b[33m${text}\x1b[0m` : text)
        },
      })
      // Update the tracked cwd. For an explicit `cd`, resolve the target against
      // the current cwd; otherwise re-read the cwd (a command may have changed it).
      if (isCd && result.exitCode === 0) {
        const target = command.replace(/^\s*(cd|chdir)\s+\/?d?\s*/i, '').replace(/"/g, '').trim()
        instance.cwd = this.resolveWinCwd(instance.cwd, target)
      } else if (result.exitCode === 0) {
        // Re-read cwd within the tracked dir so relative moves are captured.
        const probe = await instance.winrm!
          .runCommandOnShell(shellId, `${cwdPrefix}cd`, { timeoutMs: 10000 })
          .catch(() => null)
        const probeCwd = probe?.stdout.trim().split(/\r?\n/).map((l: string) => l.trim()).filter((l: string) => /^[A-Za-z]:\\/.test(l)).pop()
        if (probeCwd) instance.cwd = probeCwd
      }
    } catch (error) {
      // The persistent shell may have died (server restart, idle timeout) — drop
      // it and retry once on a fresh runspace before surfacing the error.
      instance.persistentShellId = undefined
      const shellId = await this.ensurePersistentShell(instance)
      result = await instance.winrm!.runCommandOnShell(shellId, cwdPrefix + command, {
        timeoutMs: options?.timeoutMs ?? DEFAULT_WINRM_TIMEOUT_MS,
        signal: options?.signal,
        onChunk: (stream: 'stdout' | 'stderr', text: string) => {
          if (text) instance.dataCallback?.(stream === 'stderr' ? `\x1b[33m${text}\x1b[0m` : text)
        },
      })
    }

    instance.dataCallback?.(
      `\r\n\x1b[2m[exit ${result.exitCode}]\x1b[0m\r\n`,
    )
    return result
  }

  /** Resolve a `cd` target (absolute or relative) against the tracked cwd. */
  private resolveWinCwd(currentCwd: string | undefined, target: string): string {
    if (!target) return currentCwd ?? ''
    // Absolute (X:\...) → normalize slashes, strip trailing slash.
    if (/^[A-Za-z]:[\\/]/.test(target)) {
      return target.replace(/\//g, '\\').replace(/\\+$/, '')
    }
    // Drive-only (C:) → drive root.
    if (/^[A-Za-z]:$/.test(target)) return `${target}\\`
    // Relative (.., .\x, subdir) → resolve against current cwd.
    const base = (currentCwd ?? 'C:\\').replace(/\\+$/, '')
    const parts = base.split('\\').filter(Boolean)
    for (const seg of target.replace(/\//g, '\\').split('\\')) {
      if (seg === '' || seg === '.') continue
      if (seg === '..') parts.pop()
      else parts.push(seg)
    }
    return parts.join('\\')
  }

  private async waitForReady(instance: WinRMInstance, timeoutMs: number): Promise<boolean> {
    if (instance.ready) return true
    if (instance.failed) return false
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (instance.ready) return true
      if (instance.failed) return false
      await new Promise((r) => setTimeout(r, 100))
    }
    return instance.ready
  }

  // --- Streaming PTY surface (no-ops for command/response mode) ---

  write(_ptyId: string, _data: string): void {
    // WinRM has no live stdin stream in v1; commands go through executeCommand.
    // Silently ignore interactive writes (the agent uses exec_command, not
    // write_stdin, for winrm tabs).
  }

  resize(_ptyId: string, _cols: number, _rows: number): void {
    // No PTY to resize.
  }

  kill(ptyId: string): void {
    const instance = this.instances.get(ptyId)
    if (!instance) return
    this.instances.delete(ptyId)
    // Close the persistent runspace (best-effort), then notify exit.
    if (instance.persistentShellId) {
      void instance.winrm!.deleteShell(instance.persistentShellId)
      instance.persistentShellId = undefined
    }
    instance.exitCallback?.(0)
  }

  onData(ptyId: string, callback: (data: string) => void): void {
    const instance = this.instances.get(ptyId)
    if (instance) instance.dataCallback = callback
  }

  onExit(ptyId: string, callback: (code: number) => void): void {
    const instance = this.instances.get(ptyId)
    if (instance) instance.exitCallback = callback
  }

  getCwd(ptyId: string): string | undefined {
    // Persistent cwd tracked across commands on the runspace (best-effort).
    return this.instances.get(ptyId)?.cwd
  }

  getHomeDir(_ptyId: string): Promise<string | undefined> {
    // No persistent home over WinRM in v1 (no SFTP/filesystem channel).
    return Promise.resolve(undefined)
  }

  getRemoteOs(_ptyId: string): 'unix' | 'windows' | undefined {
    return 'windows'
  }

  async getSystemInfo(ptyId: string): Promise<TerminalSystemInfo | undefined> {
    const instance = this.instances.get(ptyId)
    if (!instance || (!instance.ready && !instance.failed)) return undefined
    try {
      const r = instance.psrp
        ? await instance.psrp.runScript('$env:COMPUTERNAME', { timeoutMs: 15000 })
        : await instance.winrm!.runCommand(
            'powershell -NoProfile -Command "$env:COMPUTERNAME"',
            { timeoutMs: 15000 },
          )
      return {
        hostname: r.stdout.trim() || instance.config.host,
        os: 'win32',
        platform: 'win32',
        release: '',
        arch: '',
        isRemote: true,
      } satisfies TerminalSystemInfo
    } catch {
      return undefined
    }
  }

  getInitializationState(ptyId: string): 'ready' | 'failed' | undefined {
    const instance = this.instances.get(ptyId)
    if (!instance) return undefined
    if (instance.failed) return 'failed'
    if (instance.ready) return 'ready'
    return undefined
  }
}

// TerminalBackend = TerminalSessionBackend & Partial<TerminalFileSystemBackend>.
// WinRMBackend implements the session backend; the filesystem part is omitted
// (supportsFilesystem=false for winrm), so the class is typed as TerminalBackend
// via the registry in TerminalService.
