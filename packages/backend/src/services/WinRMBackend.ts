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
    const instance: WinRMInstance = { config: cfg, transport, ready: false, failed: false }
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

  /** Direct command execution — the path TerminalService uses for winrm tabs. */
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

    // Surface the command echo to the command/response log view.
    instance.dataCallback?.(`\r\n\x1b[36m❯ ${command}\x1b[0m\r\n`)

    const result = await instance.transport.runCommand(command, {
      timeoutMs: options?.timeoutMs ?? DEFAULT_WINRM_TIMEOUT_MS,
      signal: options?.signal,
    })

    // Render captured output into the log view (stdout + stderr).
    if (result.stdout) instance.dataCallback?.(result.stdout)
    if (result.stderr) {
      instance.dataCallback?.(`\x1b[33m${result.stderr}\x1b[0m`)
    }
    instance.dataCallback?.(
      `\r\n\x1b[2m[exit ${result.exitCode}]\x1b[0m\r\n`,
    )
    return result
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
    // WinRM is stateless per command — nothing to close. Notify exit so the
    // tab UI can update.
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

  getCwd(_ptyId: string): string | undefined {
    // No persistent cwd across stateless commands; report undefined so the
    // UI doesn't show a misleading path.
    return undefined
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
