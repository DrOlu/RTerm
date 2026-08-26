import { randomUUID } from 'crypto'
import type {
  BackendSettings,
  PlaybookEntry,
  PlaybookStep,
  PlaybookStepRollback,
  PlaybookStepValidation,
  TerminalConfig,
} from '../../types'
import type { AutomationManager } from './AutomationManager'
import type { ChangeLedger } from '../changeLedger'
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
  /** Set when the step failed (non-zero exit / error / missing script / failed validation). */
  error?: string
  exitCode?: number
  /** Truncated combined output (last ~4k chars) for command/script steps. */
  output?: string
  /** True when the step failed but the playbook continued past it. */
  continuedAfterFailure?: boolean
  /** Validation outcome when the step defines one. */
  validation?: { ok: boolean; error?: string }
  /** True when this step's rollback action was executed during the undo sequence. */
  rolledBack?: boolean
  /** Set when the rollback action itself failed. */
  rollbackError?: string
}

export interface PlaybookTargetOutcome {
  target: string
  ok: boolean
  steps: PlaybookStepOutcome[]
  /** Set when the target itself could not run (session failed to open). */
  error?: string
  /** True when the automatic rollback sequence ran for this target. */
  rolledBack?: boolean
  /** False when at least one rollback action failed (rolledBack must then be read with care). */
  rollbackOk?: boolean
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
  /** Durable change ledger; when provided together with changeId, every
   * execute/validate/rollback event is recorded (MOP audit trail). */
  changeLedger?: Pick<ChangeLedger, 'recordStep'>
  changeId?: string
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

/** Resolve a step to an executable command; wait/template/playbook/healthCheck steps resolve to null. */
export function resolvePlaybookStepCommand(
  step: PlaybookStep,
  automationManager: AutomationManager,
): string | null {
  if (step.kind === 'wait') return null
  if (step.kind === 'template') return null
  if (step.kind === 'playbook') return null
  if (step.kind === 'healthCheck') return null
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

/** v3.2.17: run a command with a timeout. Returns { ok, exitCode, output, error, timedOut }. */
export async function runCommandWithTimeout(
  deps: Pick<PlaybookRunnerDeps, 'terminalService'>,
  terminalId: string,
  command: string,
  timeoutSeconds: number | undefined,
): Promise<{ exitCode?: number; stdoutDelta: string; timedOut: boolean }> {
  if (!timeoutSeconds || timeoutSeconds <= 0) {
    const r = await deps.terminalService.runCommandAndWait(terminalId, command)
    return { exitCode: r.exitCode, stdoutDelta: r.stdoutDelta ?? '', timedOut: false }
  }
  // Race the command against a timer. The terminal layer has no per-command
  // timeout, so we wrap it: if the timer wins, report a synthetic timeout
  // failure (the command may still complete in the background; the playbook
  // treats the step as failed and rolls back).
  return await new Promise((resolve) => {
    let settled = false
    const settle = (v: { exitCode?: number; stdoutDelta: string; timedOut: boolean }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(v)
    }
    const timer = setTimeout(() => {
      settle({ exitCode: -1, stdoutDelta: '', timedOut: true })
    }, timeoutSeconds * 1000)
    deps.terminalService
      .runCommandAndWait(terminalId, command)
      .then((r) => settle({ exitCode: r.exitCode, stdoutDelta: r.stdoutDelta ?? '', timedOut: false }))
      .catch(() => settle({ exitCode: -1, stdoutDelta: '', timedOut: false }))
  })
}

/** v3.2.17: evaluate a `when` condition. Supports:
 *  - a shell-ish expression like "{{env}} == 'prod'" (== / != against the param map)
 *  - anything else is treated as a check command (exit 0 = run the step). */
export function evaluateWhen(
  when: string,
  paramValues: Record<string, string>,
): { mode: 'expression' | 'command'; result: boolean; command?: string } {
  const exprMatch = when.match(/^\{\{\s*([\w.]+)\s*\}\}\s*(==|!=)\s*(.+)$/)
  if (exprMatch) {
    const [, varName, op, rawValue] = exprMatch
    const actual = paramValues[varName] ?? ''
    const expected = rawValue.trim().replace(/^['"]|['"]$/g, '')
    return { mode: 'expression', result: op === '==' ? actual === expected : actual !== expected }
  }
  // Otherwise it's a check command — the caller runs it and requires exit 0.
  return { mode: 'command', result: false, command: when }
}

/** v3.2.17: build the env prefix for a command step (export VAR='value' && ...). */
export function buildEnvPrefix(
  env: Record<string, string> | undefined,
  paramValues: Record<string, string>,
): string {
  if (!env || Object.keys(env).length === 0) return ''
  const exports = Object.entries(env).map(([k, v]) => {
    const value = v.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, name) => paramValues[name] ?? '')
    // Single-quote the value, escaping embedded single quotes.
    const safe = value.replace(/'/g, "'\\''")
    return `export ${k}='${safe}'`
  })
  return exports.join(' && ') + ' && '
}

/** v3.2.17: dry-run plan — resolve targets + commands WITHOUT executing anything. */
export interface PlaybookDryRunPlan {
  playbookId: string
  playbookName: string
  targets: Array<{ name: string; kind: string }>
  steps: Array<{ index: number; name?: string; kind: string; command?: string; timeoutSeconds?: number; retryAttempts?: number; when?: string }>
  notes: string[]
}

export function buildPlaybookDryRunPlan(
  deps: Pick<PlaybookRunnerDeps, 'automationManager' | 'getSettings'>,
  playbook: PlaybookEntry,
): PlaybookDryRunPlan {
  const settings = deps.getSettings()
  const scope = { groupId: playbook.groupId, tags: playbook.tags, targets: playbook.targets }
  const targets = resolveScheduledTaskTargets(scope, settings)
  const notes: string[] = []
  const steps: PlaybookDryRunPlan['steps'] = []

  playbook.steps.forEach((step, i) => {
    const entry: PlaybookDryRunPlan['steps'][number] = {
      index: i,
      name: step.name,
      kind: step.kind,
      timeoutSeconds: step.timeoutSeconds ?? playbook.defaultStepTimeoutSeconds,
      retryAttempts: step.retryAttempts ?? playbook.defaultStepRetryAttempts,
      when: step.when,
    }
    try {
      if (step.kind === 'wait') {
        entry.command = `# wait ${step.waitSeconds ?? 0}s`
      } else if (step.kind === 'template') {
        entry.command = `# render template ${step.templateId} → ${step.templateTargetPath ?? '(no path)'}`
        if (!step.templateId) notes.push(`Step ${i + 1}: template step missing templateId`)
        if (!step.templateTargetPath) notes.push(`Step ${i + 1}: template step missing templateTargetPath`)
      } else if (step.kind === 'playbook') {
        entry.command = `# sub-playbook ${step.playbookId}`
        if (!step.playbookId) notes.push(`Step ${i + 1}: playbook step missing playbookId`)
      } else if (step.kind === 'healthCheck') {
        entry.command = `# healthCheck ${step.healthUrl} expect ${step.healthExpectStatus ?? 200}`
        if (!step.healthUrl) notes.push(`Step ${i + 1}: healthCheck step missing healthUrl`)
      } else {
        const cmd = resolvePlaybookStepCommand(step, deps.automationManager)
        entry.command = cmd ?? undefined
      }
    } catch (e) {
      entry.command = `# ERROR: ${e instanceof Error ? e.message : String(e)}`
      notes.push(`Step ${i + 1}: ${e instanceof Error ? e.message : String(e)}`)
    }
    steps.push(entry)
  })

  if (playbook.maxParallelTargets && playbook.maxParallelTargets > 1) {
    notes.push(`Targets run in parallel (max ${playbook.maxParallelTargets}).`)
  }
  if (playbook.maxRuntimeMinutes) {
    notes.push(`Circuit breaker: aborts after ${playbook.maxRuntimeMinutes} minutes.`)
  }

  return {
    playbookId: playbook.id,
    playbookName: playbook.name,
    targets: targets.length === 0
      ? [{ name: 'local', kind: 'local' }]
      : targets.map((t) => ({ name: t.name, kind: t.kind })),
    steps,
    notes,
  }
}

/** Resolve a validation check to an executable command. */
export function resolveValidationCommand(
  validate: PlaybookStepValidation,
  automationManager: AutomationManager,
): string {
  if ((validate.command ?? '').trim()) return validate.command!.trim()
  const script = automationManager.listScripts().find((s) => s.id === validate.scriptId)
  if (!script) throw new Error(`validation references missing script "${validate.scriptId}"`)
  const cmd = (script.command ?? '').trim()
  if (!cmd) throw new Error(`validation script "${script.name}" has an empty command`)
  return cmd
}

/** Match validation output against the expected pattern. */
export function matchExpectation(output: string, expect: string, mode?: 'substring' | 'regex'): boolean {
  if (mode === 'regex') {
    try {
      return new RegExp(expect, 'm').test(output)
    } catch {
      // Invalid regex falls back to substring so a bad pattern never crashes a run.
      return output.includes(expect)
    }
  }
  return output.includes(expect)
}

/** Resolve a rollback action to an executable command. */
export function resolveRollbackCommand(
  rollback: PlaybookStepRollback,
  automationManager: AutomationManager,
): string {
  if (rollback.kind === 'command') {
    const cmd = (rollback.command ?? '').trim()
    if (!cmd) throw new Error('rollback has an empty command')
    return cmd
  }
  const script = automationManager.listScripts().find((s) => s.id === rollback.scriptId)
  if (!script) throw new Error(`rollback references missing script "${rollback.scriptId}"`)
  const cmd = (script.command ?? '').trim()
  if (!cmd) throw new Error(`rollback script "${script.name}" has an empty command`)
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

  const ledger = deps.changeLedger
  const changeId = deps.changeId
  const recordLedger = (target: string, s: { stepIndex: number; name?: string; kind: string }, phase: 'execute' | 'validate' | 'rollback', ok: boolean, detail?: string): void => {
    if (!ledger || !changeId) return
    try {
      ledger.recordStep({ changeId, target, stepIndex: s.stepIndex, stepName: s.name, kind: s.kind, phase, ok, detail })
    } catch {
      // Ledger is best-effort; never break a run for audit.
    }
  }

  const runTarget = async (name: string, config: TerminalConfig): Promise<PlaybookTargetOutcome> => {
    const outcome: PlaybookTargetOutcome = { target: name, ok: true, steps: [] }
    /** Undo stack: indexes of completed steps that define a rollback action. */
    const undoStack: number[] = []
    let terminalId: string | null = null
    /** Execute one rollback command on the target session; returns ok + error. */
    const runRollback = async (stepIndex: number): Promise<{ ok: boolean; error?: string }> => {
      const step = playbook.steps[stepIndex]
      const stepOutcome = outcome.steps.find((s) => s.stepIndex === stepIndex)
      if (!step.rollback) return { ok: true }
      try {
        const cmd = resolveRollbackCommand(step.rollback, deps.automationManager)
        log(`[playbook] "${playbook.name}" @ ${name}: rollback step ${stepIndex + 1}${step.name ? ` (${step.name})` : ''}`)
        const result = await deps.terminalService.runCommandAndWait(terminalId!, cmd)
        const ok = result.exitCode === 0 || result.exitCode === undefined
        const error = ok ? undefined : `rollback exit code ${result.exitCode}`
        if (stepOutcome) {
          stepOutcome.rolledBack = true
          if (!ok) stepOutcome.rollbackError = error
        }
        recordLedger(name, { stepIndex, name: step.name, kind: step.kind }, 'rollback', ok, error ?? tail(result.stdoutDelta ?? ''))
        return { ok, error }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        if (stepOutcome) {
          stepOutcome.rolledBack = true
          stepOutcome.rollbackError = msg
        }
        recordLedger(name, { stepIndex, name: step.name, kind: step.kind }, 'rollback', false, msg)
        return { ok: false, error: msg }
      }
    }
    /** Automatic undo: failed step's own rollback first, then completed steps in reverse order. */
    const unwind = async (failedStepIndex: number): Promise<void> => {
      outcome.rolledBack = true
      outcome.rollbackOk = true
      if (playbook.steps[failedStepIndex]?.rollback) {
        const r = await runRollback(failedStepIndex)
        if (!r.ok) outcome.rollbackOk = false
      }
      for (let i = undoStack.length - 1; i >= 0; i--) {
        const r = await runRollback(undoStack[i])
        if (!r.ok) outcome.rollbackOk = false
      }
      log(`[playbook] "${playbook.name}" @ ${name}: rollback sequence ${outcome.rollbackOk ? 'completed' : 'completed WITH FAILURES'}`)
    }
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

          // v3.2.17: conditional execution — skip the step when `when` is false.
          if (step.when) {
            const cond = evaluateWhen(step.when, {})
            if (cond.mode === 'expression') {
              if (!cond.result) {
                log(`[playbook] "${playbook.name}" @ ${name}: step ${i + 1} skipped (when: ${step.when})`)
                stepOutcome.output = `# skipped (when: ${step.when})`
                continue
              }
            } else if (cond.command) {
              // Command-mode when: must exit 0 to run the step.
              const check = await deps.terminalService.runCommandAndWait(terminalId, cond.command)
              if (check.exitCode !== 0 && check.exitCode !== undefined) {
                log(`[playbook] "${playbook.name}" @ ${name}: step ${i + 1} skipped (when-check exit ${check.exitCode})`)
                stepOutcome.output = `# skipped (when-check exit ${check.exitCode})`
                continue
              }
            }
          }

          // v3.2.17: new step kinds.
          if (step.kind === 'template') {
            // Render the saved template and write it to the target.
            const template = deps.automationManager.listTemplates().find((t) => t.id === step.templateId)
            if (!template) throw new Error(`template step references missing template "${step.templateId}"`)
            if (!step.templateTargetPath) throw new Error('template step missing templateTargetPath')
            const { renderTemplate } = await import('./templateEngine')
            const rendered = renderTemplate(template.body, step.templateValues ?? {})
            const encoded = Buffer.from(rendered, 'utf8').toString('base64')
            const writeCmd = `echo '${encoded}' | base64 -d > ${step.templateTargetPath}`
            log(`[playbook] "${playbook.name}" @ ${name}: step ${i + 1} (template → ${step.templateTargetPath})`)
            const result = await runCommandWithTimeout(deps, terminalId, writeCmd, step.timeoutSeconds ?? playbook.defaultStepTimeoutSeconds)
            stepOutcome.exitCode = result.exitCode
            stepOutcome.output = `# wrote ${rendered.length} bytes to ${step.templateTargetPath}`
            stepOutcome.ok = result.exitCode === 0 || result.exitCode === undefined
            if (!stepOutcome.ok) stepOutcome.error = result.timedOut ? 'template write timed out' : `exit code ${result.exitCode}`
            recordLedger(name, stepOutcome, 'execute', stepOutcome.ok, stepOutcome.output)
            if (!stepOutcome.ok) throw new Error(stepOutcome.error)
            continue
          }

          if (step.kind === 'healthCheck') {
            // Poll a URL until it returns the expected status.
            if (!step.healthUrl) throw new Error('healthCheck step missing healthUrl')
            const expectStatus = step.healthExpectStatus ?? 200
            const timeoutSec = step.healthTimeoutSeconds ?? 60
            const intervalSec = step.healthIntervalSeconds ?? 5
            const deadline = Date.now() + timeoutSec * 1000
            log(`[playbook] "${playbook.name}" @ ${name}: step ${i + 1} (healthCheck ${step.healthUrl})`)
            let healthy = false
            let lastStatus = 0
            while (Date.now() < deadline) {
              const checkCmd = `curl -s -o /dev/null -w '%{http_code}' ${step.healthUrl.replace(/'/g, "'\\''")}`
              const r = await deps.terminalService.runCommandAndWait(terminalId, checkCmd)
              lastStatus = Number((r.stdoutDelta ?? '').trim()) || 0
              if (lastStatus === expectStatus) { healthy = true; break }
              await sleep(intervalSec * 1000)
            }
            stepOutcome.ok = healthy
            stepOutcome.output = `# healthCheck ${step.healthUrl} → HTTP ${lastStatus} (expected ${expectStatus})`
            if (!healthy) stepOutcome.error = `healthCheck failed: HTTP ${lastStatus} != ${expectStatus} after ${timeoutSec}s`
            recordLedger(name, stepOutcome, 'execute', healthy, stepOutcome.output)
            if (!healthy) throw new Error(stepOutcome.error)
            continue
          }

          if (step.kind === 'playbook') {
            // Run a sub-playbook on the same target scope.
            if (!step.playbookId) throw new Error('playbook step missing playbookId')
            const sub = deps.automationManager.listPlaybooks().find((p) => p.id === step.playbookId || p.name === step.playbookId)
            if (!sub) throw new Error(`playbook step references missing playbook "${step.playbookId}"`)
            log(`[playbook] "${playbook.name}" @ ${name}: step ${i + 1} (sub-playbook "${sub.name}")`)
            const subRecord = await executePlaybook(
              { ...deps, onLog: log },
              { ...sub, targets: playbook.targets, tags: playbook.tags, groupId: playbook.groupId },
            )
            stepOutcome.ok = subRecord.ok
            stepOutcome.output = `# sub-playbook "${sub.name}" ${subRecord.ok ? 'ok' : 'FAILED'} on ${subRecord.targets.length} target(s)`
            if (!subRecord.ok) {
              const failed = subRecord.targets.filter((t) => !t.ok).map((t) => t.target)
              stepOutcome.error = `sub-playbook "${sub.name}" failed on: ${failed.join(', ')}`
            }
            recordLedger(name, stepOutcome, 'execute', stepOutcome.ok, stepOutcome.output)
            if (!stepOutcome.ok) throw new Error(stepOutcome.error)
            continue
          }

          const rawCommand = resolvePlaybookStepCommand(step, deps.automationManager)!
          // v3.2.17: env prefix injection.
          const command = buildEnvPrefix(step.env, {}) + rawCommand
          log(`[playbook] "${playbook.name}" @ ${name}: step ${i + 1}/${playbook.steps.length}${step.name ? ` (${step.name})` : ''}`)

          // v3.2.17: retry loop — retry a failed step up to retryAttempts times.
          const maxAttempts = 1 + Math.max(0, step.retryAttempts ?? playbook.defaultStepRetryAttempts ?? 0)
          const retryDelay = Math.max(0, step.retryDelaySeconds ?? 30)
          const timeoutSec = step.timeoutSeconds ?? playbook.defaultStepTimeoutSeconds
          let attempt = 0
          let result: { exitCode?: number; stdoutDelta: string; timedOut: boolean } | null = null
          while (attempt < maxAttempts) {
            attempt++
            result = await runCommandWithTimeout(deps, terminalId, command, timeoutSec)
            const ok = result.exitCode === 0 || result.exitCode === undefined
            if (ok) break
            if (attempt < maxAttempts) {
              log(`[playbook] "${playbook.name}" @ ${name}: step ${i + 1} attempt ${attempt}/${maxAttempts} failed (${result.timedOut ? 'timeout' : `exit ${result.exitCode}`}) — retrying in ${retryDelay}s`)
              await sleep(retryDelay * 1000)
            }
          }
          const finalResult = result!
          stepOutcome.exitCode = finalResult.exitCode
          // v3.2.17: full output capture when requested.
          stepOutcome.output = step.outputCapture === 'full'
            ? finalResult.stdoutDelta
            : tail(finalResult.stdoutDelta)
          stepOutcome.ok = finalResult.exitCode === 0 || finalResult.exitCode === undefined
          if (!stepOutcome.ok) {
            stepOutcome.error = finalResult.timedOut
              ? `timed out after ${timeoutSec}s`
              : `exit code ${finalResult.exitCode}`
          }
          recordLedger(name, stepOutcome, 'execute', stepOutcome.ok, stepOutcome.ok ? stepOutcome.output : stepOutcome.error)
          // Post-step validation: a mismatch fails the step just like a non-zero exit.
          if (stepOutcome.ok && step.validate) {
            try {
              const checkCmd = resolveValidationCommand(step.validate, deps.automationManager)
              const check = await deps.terminalService.runCommandAndWait(terminalId, checkCmd)
              const matched = matchExpectation(check.stdoutDelta ?? '', step.validate.expect, step.validate.expectMode)
              stepOutcome.validation = { ok: matched, ...(matched ? {} : { error: `validation pattern not found in output` }) }
              recordLedger(name, stepOutcome, 'validate', matched, matched ? undefined : `expect ${step.validate.expectMode ?? 'substring'} "${step.validate.expect}" — got: ${tail(check.stdoutDelta ?? '').slice(-500)}`)
              if (!matched) {
                stepOutcome.ok = false
                stepOutcome.error = `validation failed: expected ${step.validate.expectMode ?? 'substring'} "${step.validate.expect}" in check output`
              }
            } catch (error) {
              const msg = error instanceof Error ? error.message : String(error)
              stepOutcome.validation = { ok: false, error: msg }
              recordLedger(name, stepOutcome, 'validate', false, msg)
              stepOutcome.ok = false
              stepOutcome.error = `validation error: ${msg}`
            }
          }
        } catch (error) {
          stepOutcome.ok = false
          stepOutcome.error = error instanceof Error ? error.message : String(error)
          recordLedger(name, stepOutcome, 'execute', false, stepOutcome.error)
        }
        if (!stepOutcome.ok) {
          outcome.ok = false
          if (policy === 'continue') {
            stepOutcome.continuedAfterFailure = true
            // A failed-but-continued step may have partial effects: keep its
            // rollback reachable if a later step stops the target.
            if (step.rollback) undoStack.push(i)
            log(`[playbook] "${playbook.name}" @ ${name}: step ${i + 1} failed (${stepOutcome.error}) — continuing`)
            continue
          }
          log(`[playbook] "${playbook.name}" @ ${name}: step ${i + 1} failed (${stepOutcome.error}) — stopping target`)
          // MOP semantics: automatically undo this target's completed steps, in reverse.
          if (playbook.steps[i].rollback || undoStack.length > 0) {
            await unwind(i)
          }
          return outcome
        }
        if (step.rollback) undoStack.push(i)
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
    // v3.2.17: parallel targets (default 1 = one at a time, preserving the
    // current safety posture) + onTargetError policy + maxRuntime circuit breaker.
    const maxParallel = Math.max(1, playbook.maxParallelTargets ?? 1)
    const onTargetError = playbook.onTargetError ?? 'stop'
    const runtimeDeadline = playbook.maxRuntimeMinutes
      ? Date.now() + playbook.maxRuntimeMinutes * 60_000
      : Number.POSITIVE_INFINITY
    const configs = targets.map((target) => {
      log(`[playbook] "${playbook.name}" → ${target.kind}://${target.name}`)
      const config =
        target.kind === 'ssh'
          ? sshEntryToConfig(target.ssh!, settings)
          : target.kind === 'winrm'
            ? winrmEntryToConfig(target.winrm!)
            : serialEntryToConfig(target.serial!)
      return { name: target.name, config }
    })

    if (maxParallel <= 1) {
      // Sequential (current behavior) + circuit breaker + target policy.
      for (const { name, config } of configs) {
        if (Date.now() > runtimeDeadline) {
          log(`[playbook] "${playbook.name}": maxRuntimeMinutes exceeded — aborting remaining targets`)
          record.targets.push({ target: name, ok: false, steps: [], error: 'playbook runtime limit exceeded' })
          if (onTargetError === 'stop') break
          continue
        }
        const t = await runTarget(name, config)
        record.targets.push(t)
        if (!t.ok && onTargetError === 'stop') {
          log(`[playbook] "${playbook.name}": target ${name} failed — stopping remaining targets (onTargetError=stop)`)
          break
        }
      }
    } else {
      // Parallel batches of maxParallel.
      for (let i = 0; i < configs.length; i += maxParallel) {
        if (Date.now() > runtimeDeadline) {
          log(`[playbook] "${playbook.name}": maxRuntimeMinutes exceeded — aborting remaining targets`)
          break
        }
        const batch = configs.slice(i, i + maxParallel)
        const results = await Promise.all(batch.map(({ name, config }) => runTarget(name, config)))
        results.forEach((t) => record.targets.push(t))
        if (onTargetError === 'stop' && results.some((t) => !t.ok)) {
          log(`[playbook] "${playbook.name}": a target in this batch failed — stopping remaining targets (onTargetError=stop)`)
          break
        }
      }
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
