import { randomUUID } from 'crypto'
import type {
  BackendSettings,
  ScheduledTaskEntry,
  SerialConnectionEntry,
  SSHConnectionEntry,
  TerminalConfig,
  WinRMConnectionEntry,
} from '../../types'
import type { AutomationManager } from './AutomationManager'

/**
 * Scheduled-task runner — the execution half of SchedulerService.
 *
 * The scheduler decides *when* a task is due; this module decides *how* it
 * runs: resolve the command (inline or via a saved script), resolve the
 * targets (explicit connection names, a group, or nothing → local shell),
 * open a short-lived headless terminal per target, run the command to
 * completion, then tear the terminal down. When session logging is enabled,
 * the terminal output is captured by the regular SessionLogService wiring —
 * the runner's terminals look like any other session on disk.
 *
 * Everything is injectable so tests can fake the terminal layer.
 */

export interface ScheduledTaskRunOutcome {
  /** Display name of the target ("local" when no scope is configured). */
  target: string
  ok: boolean
  exitCode?: number
  error?: string
  /** Truncated combined output (last ~4k chars) for logging/diagnostics. */
  output?: string
}

export interface ScheduledTaskTerminalService {
  createTerminal(config: TerminalConfig): Promise<{ id: string }>
  runCommandAndWait(
    terminalId: string,
    command: string,
  ): Promise<{ stdoutDelta: string; exitCode?: number }>
  kill(terminalId: string): void
  getAllTerminals(): Array<{ id: string; runtimeState?: string }>
}

export interface ScheduledTaskRunnerDeps {
  terminalService: ScheduledTaskTerminalService
  automationManager: AutomationManager
  getSettings: () => BackendSettings
  /** Max time to wait for a target session to reach `ready`. Default 60s. */
  readyTimeoutMs?: number
  /** Poll interval while waiting for readiness. Default 500ms. */
  readyPollMs?: number
  onLog?: (line: string) => void
}

const OUTPUT_TAIL = 4096

const tail = (s: string): string =>
  s.length > OUTPUT_TAIL ? s.slice(s.length - OUTPUT_TAIL) : s

const norm = (s: string | undefined): string => (s ?? '').trim().toLowerCase()

/** Resolve the shell command for a task: inline command, else saved script. */
export function resolveScheduledTaskCommand(
  task: ScheduledTaskEntry,
  automationManager: AutomationManager,
): string {
  const inline = (task.command ?? '').trim()
  if (inline) return inline
  if (task.scriptId) {
    const script = automationManager
      .listScripts()
      .find((s) => s.id === task.scriptId)
    if (!script) {
      throw new Error(
        `Scheduled task "${task.name}" references missing script "${task.scriptId}"`,
      )
    }
    const command = (script.command ?? '').trim()
    if (!command) {
      throw new Error(
        `Scheduled task "${task.name}" script "${script.name}" has an empty command`,
      )
    }
    return command
  }
  throw new Error(
    `Scheduled task "${task.name}" has neither an inline command nor a scriptId`,
  )
}

export interface ResolvedTarget {
  name: string
  kind: 'ssh' | 'winrm' | 'serial'
  ssh?: SSHConnectionEntry
  winrm?: WinRMConnectionEntry
  serial?: SerialConnectionEntry
}

/** The targeting scope shared by scripts, scheduled tasks, and playbooks. */
export interface TargetScope {
  groupId?: string
  tags?: string[]
  targets?: string[]
}

/** Resolve which saved connections a scope should run against. */
export function resolveScheduledTaskTargets(
  task: TargetScope,
  settings: BackendSettings,
): ResolvedTarget[] {
  const connections = settings.connections ?? {
    ssh: [],
    winrm: [],
    serial: [],
    proxies: [],
    tunnels: [],
  }
  const ssh = connections.ssh ?? []
  const winrm = connections.winrm ?? []
  const serial = connections.serial ?? []

  const wantedNames = new Set((task.targets ?? []).map(norm))
  const wantedTags = new Set((task.tags ?? []).map(norm))
  const byScope = (entry: {
    name: string
    groupId?: string
    tags?: string[]
  }): boolean => {
    if (task.groupId && entry.groupId === task.groupId) return true
    if (wantedNames.size > 0 && wantedNames.has(norm(entry.name))) return true
    if (wantedTags.size > 0) {
      const entryTags = (entry.tags ?? []).map(norm)
      if (entryTags.some((t) => wantedTags.has(t))) return true
    }
    return false
  }
  // An empty scope means "run locally" — handled by the caller.
  if (!task.groupId && wantedNames.size === 0 && wantedTags.size === 0) {
    return []
  }

  const targets: ResolvedTarget[] = []
  for (const e of ssh.filter(byScope)) {
    targets.push({ name: e.name, kind: 'ssh', ssh: e })
  }
  for (const e of winrm.filter(byScope)) {
    targets.push({ name: e.name, kind: 'winrm', winrm: e })
  }
  for (const e of serial.filter(byScope)) {
    targets.push({ name: e.name, kind: 'serial', serial: e })
  }
  return targets
}

export function sshEntryToConfig(
  entry: SSHConnectionEntry,
  settings: BackendSettings,
): TerminalConfig {
  const proxy = entry.proxyId
    ? (settings.connections?.proxies ?? []).find(
        (p) => p.id === entry.proxyId,
      )
    : undefined
  return {
    type: 'ssh',
    id: `sch-${randomUUID()}`,
    title: `[sched] ${entry.name}`,
    cols: 120,
    rows: 32,
    host: entry.host,
    port: entry.port,
    username: entry.username,
    authMethod: entry.authMethod,
    password: entry.password,
    privateKey: entry.privateKey,
    privateKeyPath: entry.privateKeyPath,
    passphrase: entry.passphrase,
    algorithmsPreset: entry.algorithmsPreset,
    termType: entry.termType,
    proxy,
    jumpHost: entry.jumpHost as never,
  } as TerminalConfig
}

export function winrmEntryToConfig(entry: WinRMConnectionEntry): TerminalConfig {
  return {
    type: 'winrm',
    id: `sch-${randomUUID()}`,
    title: `[sched] ${entry.name}`,
    cols: 120,
    rows: 32,
    host: entry.host,
    port: entry.port,
    username: entry.username,
    password: entry.password,
    transport: entry.transport,
    auth: entry.auth,
    domain: entry.domain,
    rejectUnauthorized: entry.rejectUnauthorized,
  } as TerminalConfig
}

export function serialEntryToConfig(entry: SerialConnectionEntry): TerminalConfig {
  return {
    type: 'serial',
    id: `sch-${randomUUID()}`,
    title: `[sched] ${entry.name}`,
    cols: 120,
    rows: 32,
    path: entry.path,
    baudRate: entry.baudRate,
    dataBits: entry.dataBits,
    parity: entry.parity,
    stopBits: entry.stopBits,
    flowControl: entry.flowControl,
  } as unknown as TerminalConfig
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/** Execute one due scheduled task. Never throws for per-target failures —
 * they are reported in the outcome list; a throw means the task itself is
 * misconfigured (no command). */
export async function executeScheduledTask(
  deps: ScheduledTaskRunnerDeps,
  task: ScheduledTaskEntry,
): Promise<ScheduledTaskRunOutcome[]> {
  const log = deps.onLog ?? (() => {})

  // v3.2.16: task → playbook binding. When a playbookId is set, run the
  // playbook (with its validation + rollback) instead of a raw command.
  if (task.playbookId) {
    const playbook = deps.automationManager.getPlaybook(task.playbookId)
    if (!playbook) {
      return [{
        target: 'playbook',
        ok: false,
        error: `scheduled task "${task.name}" references missing playbook "${task.playbookId}"`,
      }]
    }
    if (playbook.requireApproval) {
      return [{
        target: 'playbook',
        ok: false,
        error: `playbook "${playbook.name}" is MOP-gated (requireApproval); schedule it via a change record instead`,
      }]
    }
    return executePlaybookForTask(deps, task, playbook)
  }

  const command = resolveScheduledTaskCommand(task, deps.automationManager)
  const settings = deps.getSettings()
  const targets = resolveScheduledTaskTargets(task, settings)
  const readyTimeoutMs = deps.readyTimeoutMs ?? 60_000
  const readyPollMs = deps.readyPollMs ?? 500

  const runOne = async (
    name: string,
    config: TerminalConfig,
  ): Promise<ScheduledTaskRunOutcome> => {
    let terminalId: string | null = null
    try {
      const tab = await deps.terminalService.createTerminal(config)
      terminalId = tab.id
      // Wait for the session to become ready (SSH handshake, shell spawn…).
      const deadline = Date.now() + readyTimeoutMs
      for (;;) {
        const current = deps.terminalService
          .getAllTerminals()
          .find((t) => t.id === terminalId)
        const state = current?.runtimeState
        if (state === 'ready') break
        if (state === 'exited') {
          return {
            target: name,
            ok: false,
            error: 'session exited before becoming ready',
          }
        }
        if (Date.now() > deadline) {
          return { target: name, ok: false, error: 'session ready timeout' }
        }
        await sleep(readyPollMs)
      }
      const result = await deps.terminalService.runCommandAndWait(
        terminalId,
        command,
      )
      const exitCode = result.exitCode
      const ok = exitCode === 0 || exitCode === undefined
      return {
        target: name,
        ok,
        exitCode,
        output: tail(result.stdoutDelta ?? ''),
        ...(ok ? {} : { error: `exit code ${exitCode}` }),
      }
    } catch (error) {
      return {
        target: name,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }
    } finally {
      if (terminalId) {
        try {
          deps.terminalService.kill(terminalId)
        } catch {
          // Best-effort cleanup only.
        }
      }
    }
  }

  const outcomes: ScheduledTaskRunOutcome[] = []
  if (targets.length === 0) {
    log(
      `[scheduler] task "${task.name}": no target scope — running on the local shell`,
    )
    outcomes.push(
      await runOne('local', {
        type: 'local',
        id: `sch-${randomUUID()}`,
        title: `[sched] ${task.name}`,
        cols: 120,
        rows: 32,
      } as TerminalConfig),
    )
    return applyRetries(deps, task, outcomes, runOne, outcomes)
  }

  for (const target of targets) {
    log(`[scheduler] task "${task.name}" → ${target.kind}://${target.name}`)
    const config =
      target.kind === 'ssh'
        ? sshEntryToConfig(target.ssh!, settings)
        : target.kind === 'winrm'
          ? winrmEntryToConfig(target.winrm!)
          : serialEntryToConfig(target.serial!)
    outcomes.push(await runOne(target.name, config))
  }
  return outcomes
}

/** v3.2.16: retry failed targets per the task's retryAttempts/retryDelaySeconds. */
async function applyRetries(
  deps: ScheduledTaskRunnerDeps,
  task: ScheduledTaskEntry,
  outcomes: ScheduledTaskRunOutcome[],
  _runOne: unknown,
  _initial: ScheduledTaskRunOutcome[],
): Promise<ScheduledTaskRunOutcome[]> {
  const attempts = task.retryAttempts ?? 0
  const delaySec = task.retryDelaySeconds ?? 60
  if (attempts <= 0) return outcomes
  const log = deps.onLog ?? (() => {})
  const final = [...outcomes]
  for (let i = 0; i < final.length; i++) {
    let outcome = final[i]
    let attempt = 0
    while (!outcome.ok && attempt < attempts) {
      attempt += 1
      log(
        `[scheduler] task "${task.name}" target ${outcome.target} failed (${outcome.error}); retry ${attempt}/${attempts} in ${delaySec}s`,
      )
      await sleep(delaySec * 1000)
      // Re-run the whole task for the failing target only.
      try {
        const retryOutcomes = await executeScheduledTaskNoRetry(deps, task)
        const match = retryOutcomes.find((o) => o.target === outcome.target)
        if (match) outcome = match
      } catch {
        // keep the previous outcome
      }
    }
    final[i] = outcome
  }
  return final
}

/** Execute without the retry wrapper (used by applyRetries to avoid recursion). */
async function executeScheduledTaskNoRetry(
  deps: ScheduledTaskRunnerDeps,
  task: ScheduledTaskEntry,
): Promise<ScheduledTaskRunOutcome[]> {
  const { retryAttempts, ...taskWithoutRetry } = task
  void retryAttempts
  return executeScheduledTask(deps, { ...taskWithoutRetry, retryAttempts: 0 })
}

/** v3.2.16: run a playbook for a task (validation + rollback inherited). */
async function executePlaybookForTask(
  deps: ScheduledTaskRunnerDeps,
  task: ScheduledTaskEntry,
  playbook: { id: string; name: string; steps: unknown[]; params?: unknown; maxParallelSteps?: number; requireApproval?: boolean },
): Promise<ScheduledTaskRunOutcome[]> {
  const log = deps.onLog ?? (() => {})
  log(`[scheduler] task "${task.name}" → playbook "${playbook.name}" (${playbook.steps.length} steps)`)
  try {
    const { executePlaybook } = await import('./playbookRunner')
    const { executeOrchestratedPlaybook } = await import('./orchestratedPlaybookRunner')
    const { playbookNeedsOrchestration } = await import('../AgentHelper/tools/playbook_tools')
    const settings = deps.getSettings()
    const record = playbookNeedsOrchestration(playbook as never)
      ? await executeOrchestratedPlaybook(
          {
            terminalService: deps.terminalService as never,
            automationManager: deps.automationManager,
            getSettings: () => settings,
            onLog: () => {},
            paramValues: {},
          },
          playbook as never,
        )
      : await executePlaybook(
          {
            terminalService: deps.terminalService as never,
            automationManager: deps.automationManager,
            getSettings: () => settings,
            onLog: () => {},
          },
          playbook as never,
        )
    const ok = (record as { status?: string })?.status !== 'failed'
    return [{
      target: `playbook:${playbook.name}`,
      ok,
      output: tail(JSON.stringify(record).slice(0, 2048)),
      ...(ok ? {} : { error: `playbook status: ${(record as { status?: string })?.status ?? 'unknown'}` }),
    }]
  } catch (error) {
    return [{
      target: `playbook:${playbook.name}`,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }]
  }
}
