import { randomUUID } from 'node:crypto'
import type {
  TerminalConfig,
  WinRMConnectionConfig,
  TerminalSystemInfo,
  TerminalBackend,
} from '../types'
import { WinRMTransport } from './WinRMTransport'

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
  transport: WinRMTransport
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
    const instance: WinRMInstance = { config: cfg, transport, ready: false, failed: false, commandQueue: Promise.resolve() }
    this.instances.set(ptyId, instance)

    // Verify reachability in the background so the tab flips to ready/exited
    // the same way SSH tabs do. We emit a banner via onData on success, and
    // onExit on failure (which TerminalService maps to runtimeState=exited).
    void this.probe(instance).then((ok) => {
      if (ok) {
        instance.ready = true
        instance.dataCallback?.(
          `\x1b[32m✔ WinRM session ready to ${cfg.host}:${cfg.port} (command/response mode — Windows Server).\x1b[0m\r\n` +
            `Run commands with exec_command / run_fleet_command. Interactive TUI apps are not supported over WinRM.\r\n`,
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
      await instance.transport.ping()
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      instance.dataCallback?.(
        `\x1b[31m✘ WinRM connection failed: ${message}\x1b[0m\r\n`,
      )
      return false
    }
  }

  private buildTransport(cfg: WinRMConnectionConfig): WinRMTransport {
    const transport =
      cfg.transport ?? (cfg.port === 5986 ? 'https' : 'http')
    const username = cfg.domain ? `${cfg.domain}\\${cfg.username}` : cfg.username
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
      this.executeOnPersistentShell(instance, command, options),
    )
    instance.commandQueue = run.catch(() => { /* keep the queue alive */ })
    return run
  }

  /** Lazily create (or recreate) the persistent runspace. */
  private async ensurePersistentShell(instance: WinRMInstance): Promise<string> {
    if (instance.persistentShellId) return instance.persistentShellId
    const shellId = await instance.transport.createShell()
    instance.persistentShellId = shellId
    // Seed the cwd from the fresh runspace.
    try {
      const r = await instance.transport.runCommandOnShell(shellId, 'cd', { timeoutMs: 10000 })
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
      result = await instance.transport.runCommandOnShell(shellId, cwdPrefix + command, {
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
        const probe = await instance.transport
          .runCommandOnShell(shellId, `${cwdPrefix}cd`, { timeoutMs: 10000 })
          .catch(() => null)
        const probeCwd = probe?.stdout.trim().split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[A-Za-z]:\\/.test(l)).pop()
        if (probeCwd) instance.cwd = probeCwd
      }
    } catch (error) {
      // The persistent shell may have died (server restart, idle timeout) — drop
      // it and retry once on a fresh runspace before surfacing the error.
      instance.persistentShellId = undefined
      const shellId = await this.ensurePersistentShell(instance)
      result = await instance.transport.runCommandOnShell(shellId, cwdPrefix + command, {
        timeoutMs: options?.timeoutMs ?? DEFAULT_WINRM_TIMEOUT_MS,
        signal: options?.signal,
        onChunk: (stream, text) => {
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
      void instance.transport.deleteShell(instance.persistentShellId)
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
      const r = await instance.transport.runCommand(
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
