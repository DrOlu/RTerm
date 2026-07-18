import { randomUUID } from 'crypto'
import type { BackendSettings, PlaybookEntry, PlaybookStep, TerminalConfig } from '../../types'
import type { AutomationManager } from './AutomationManager'
import {
  resolveScheduledTaskTargets,
  sshEntryToConfig,
  winrmEntryToConfig,
  serialEntryToConfig,
  type ScheduledTaskTerminalService,
} from './scheduledTaskRunner'

/**
 * Playbook runner — executes an ordered, multi-step workflow against a target
 * scope. Steps run sequentially on each target (command → script → wait), and
 * targets are processed one at a time. A failing step stops the playbook for
 * that target unless the step (or playbook) sets onError: 'continue' — other
 * targets still run.
 *
 * Execution reuses the scheduled-task terminal mechanics: a short-lived
 * headless terminal per target, run-to-completion per step, then teardown.
 * Everything is injectable so tests can fake the terminal layer.
 */

export interface PlaybookStepOutcome {
  stepId: string
  stepIndex: number
  name?: string
  kind: PlaybookStep['kind']
  ok: boolean
  /** Set when the step failed (non-zero exit / error / missing script). */
  error?: string
  exitCode?: number
  /** Truncated combined output (last ~4k chars) for command/script steps. */
  output?: string
  /** True when the step failed but the playbook continued past it. */
  continuedAfterFailure?: boolean
}

export interface PlaybookTargetOutcome {
  target: string
  ok: boolean
  steps: PlaybookStepOutcome[]
  /** Set when the target itself could not run (session failed to open). */
  error?: string
}

export interface PlaybookRunRecord {
  runId: string
  playbookId: string
  playbookName: string
  startedAt: string
  endedAt?: string
  ok: boolean
  targets: PlaybookTargetOutcome[]
}

export interface PlaybookRunnerDeps {
  terminalService: ScheduledTaskTerminalService
  automationManager: AutomationManager
  getSettings: () => BackendSettings
  readyTimeoutMs?: number
  readyPollMs?: number
  /** Override the wait-step clock (tests pass 0ms sleeps). */
  sleepMs?: (ms: number) => Promise<void>
  onLog?: (line: string) => void
  /** Max run records retained in memory (default 50). */
  historyLimit?: number
}

const OUTPUT_TAIL = 4096
const tail = (s: string): string => (s.length > OUTPUT_TAIL ? s.slice(s.length - OUTPUT_TAIL) : s)
const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** In-memory ring of recent playbook runs (newest first). */
const runHistory: PlaybookRunRecord[] = []
const HISTORY_LIMIT_DEFAULT = 50

export function listPlaybookRuns(): readonly PlaybookRunRecord[] {
  return runHistory
}

export function getPlaybookRun(runId: string): PlaybookRunRecord | undefined {
  return runHistory.find((r) => r.runId === runId)
}

/** Reset the in-memory run history (tests; the runtime history is process-wide). */
export function clearPlaybookRuns(): void {
  runHistory.length = 0
}

/** Resolve a step to an executable command; wait steps resolve to null. */
export function resolvePlaybookStepCommand(
  step: PlaybookStep,
  automationManager: AutomationManager,
): string | null {
  if (step.kind === 'wait') return null
  if (step.kind === 'command') {
    const cmd = (step.command ?? '').trim()
    if (!cmd) throw new Error(`Step "${step.name ?? step.id}": empty command`)
    return cmd
  }
  const script = automationManager.listScripts().find((s) => s.id === step.scriptId)
  if (!script) {
    throw new Error(`Step "${step.name ?? step.id}" references missing script "${step.scriptId}"`)
  }
  const cmd = (script.command ?? '').trim()
  if (!cmd) throw new Error(`Step "${step.name ?? step.id}" script "${script.name}" has an empty command`)
  return cmd
}

/** Execute a playbook end-to-end. Never throws for per-step/per-target
 * failures — they are captured in the run record; a throw means the playbook
 * itself is invalid (e.g. a step references a missing script). */
export async function executePlaybook(
  deps: PlaybookRunnerDeps,
  playbook: PlaybookEntry,
): Promise<PlaybookRunRecord> {
  const log = deps.onLog ?? (() => {})
  const sleep = deps.sleepMs ?? defaultSleep
  const settings = deps.getSettings()
  const readyTimeoutMs = deps.readyTimeoutMs ?? 60_000
  const readyPollMs = deps.readyPollMs ?? 500

  const record: PlaybookRunRecord = {
    runId: `run-${randomUUID()}`,
    playbookId: playbook.id,
    playbookName: playbook.name,
    startedAt: new Date().toISOString(),
    ok: false,
    targets: [],
  }

  const scope = { groupId: playbook.groupId, tags: playbook.tags, targets: playbook.targets }
  const targets = resolveScheduledTaskTargets(scope, settings)

  const runTarget = async (name: string, config: TerminalConfig): Promise<PlaybookTargetOutcome> => {
    const outcome: PlaybookTargetOutcome = { target: name, ok: true, steps: [] }
    let terminalId: string | null = null
    try {
      const tab = await deps.terminalService.createTerminal(config)
      terminalId = tab.id
      const deadline = Date.now() + readyTimeoutMs
      for (;;) {
        const current = deps.terminalService.getAllTerminals().find((t) => t.id === terminalId)
        const state = current?.runtimeState
        if (state === 'ready') break
        if (state === 'exited') {
          outcome.ok = false
          outcome.error = 'session exited before becoming ready'
          return outcome
        }
        if (Date.now() > deadline) {
          outcome.ok = false
          outcome.error = 'session ready timeout'
          return outcome
        }
        await sleep(readyPollMs)
      }

      for (let i = 0; i < playbook.steps.length; i++) {
        const step = playbook.steps[i]
        const stepOutcome: PlaybookStepOutcome = {
          stepId: step.id,
          stepIndex: i,
          name: step.name,
          kind: step.kind,
          ok: true,
        }
        outcome.steps.push(stepOutcome)
        const policy = step.onError ?? playbook.onError ?? 'stop'
        try {
          if (step.kind === 'wait') {
            log(`[playbook] "${playbook.name}" @ ${name}: wait ${step.waitSeconds}s`)
            await sleep(Math.max(0, (step.waitSeconds ?? 0) * 1000))
            continue
          }
          const command = resolvePlaybookStepCommand(step, deps.automationManager)!
          log(`[playbook] "${playbook.name}" @ ${name}: step ${i + 1}/${playbook.steps.length}${step.name ? ` (${step.name})` : ''}`)
          const result = await deps.terminalService.runCommandAndWait(terminalId, command)
          stepOutcome.exitCode = result.exitCode
          stepOutcome.output = tail(result.stdoutDelta ?? '')
          stepOutcome.ok = result.exitCode === 0 || result.exitCode === undefined
          if (!stepOutcome.ok) stepOutcome.error = `exit code ${result.exitCode}`
        } catch (error) {
          stepOutcome.ok = false
          stepOutcome.error = error instanceof Error ? error.message : String(error)
        }
        if (!stepOutcome.ok) {
          outcome.ok = false
          if (policy === 'continue') {
            stepOutcome.continuedAfterFailure = true
            log(`[playbook] "${playbook.name}" @ ${name}: step ${i + 1} failed (${stepOutcome.error}) — continuing`)
            continue
          }
          log(`[playbook] "${playbook.name}" @ ${name}: step ${i + 1} failed (${stepOutcome.error}) — stopping target`)
          return outcome
        }
      }
      return outcome
    } catch (error) {
      outcome.ok = false
      outcome.error = error instanceof Error ? error.message : String(error)
      return outcome
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

  if (targets.length === 0) {
    log(`[playbook] "${playbook.name}": no target scope — running on the local shell`)
    record.targets.push(
      await runTarget('local', {
        type: 'local',
        id: `pb-${randomUUID()}`,
        title: `[playbook] ${playbook.name}`,
        cols: 120,
        rows: 32,
      } as TerminalConfig),
    )
  } else {
    for (const target of targets) {
      log(`[playbook] "${playbook.name}" → ${target.kind}://${target.name}`)
      const config =
        target.kind === 'ssh'
          ? sshEntryToConfig(target.ssh!, settings)
          : target.kind === 'winrm'
            ? winrmEntryToConfig(target.winrm!)
            : serialEntryToConfig(target.serial!)
      record.targets.push(await runTarget(target.name, config))
    }
  }

  record.ok = record.targets.every((t) => t.ok)
  record.endedAt = new Date().toISOString()

  // Record history (newest first, capped).
  runHistory.unshift(record)
  const cap = deps.historyLimit ?? HISTORY_LIMIT_DEFAULT
  if (runHistory.length > cap) runHistory.length = cap

  // Stamp last-run status on the entry for the UI.
  try {
    deps.automationManager.markPlaybookRun(playbook.id, record.ok)
  } catch {
    // The playbook may have been deleted mid-run; history still has the record.
  }
  return record
}
