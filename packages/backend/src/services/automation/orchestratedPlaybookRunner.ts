import type { PlaybookEntry, TerminalConfig } from '../../types'
import type { AutomationManager } from './AutomationManager'
import type { ChangeLedger } from '../changeLedger'
import {
  resolveScheduledTaskTargets,
  sshEntryToConfig,
  winrmEntryToConfig,
  serialEntryToConfig,
  type ScheduledTaskTerminalService,
} from './scheduledTaskRunner'
import {
  resolvePlaybookStepCommand,
  resolveValidationCommand,
  matchExpectation,
  type PlaybookTargetOutcome,
  type PlaybookStepOutcome,
} from './playbookRunner'
import { planDag, chunk } from './dagScheduler'
import {
  resolveParams,
  substituteVars,
  maskSecrets,
  captureVar,
  checkDesiredState,
  type ParamValues,
} from './runbookEngine'
import { randomUUID } from 'crypto'

/**
 * Orchestrated playbook runner (v1.9.1 Advanced Automation).
 *
 * Extends the linear runner with:
 *   - DAG/parallel step execution per target (dependsOn + maxParallelSteps)
 *   - runbook parameters injected at run time ({{param}}), with secret masking
 *   - idempotent desired-state steps (skip when already in desired state)
 *   - cross-host orchestration variables (captureVar from one step's output
 *     feeds {{var}} substitution in later steps)
 *
 * Per-target it reuses the same headless-terminal mechanics as the linear
 * runner. Targets still run one at a time; only steps within a target run in
 * parallel (capped). Rollback semantics are preserved for the sequential prefix
 * of steps that completed.
 */

export interface OrchestratedRunnerDeps {
  terminalService: ScheduledTaskTerminalService
  automationManager: AutomationManager
  getSettings: () => any
  readyTimeoutMs?: number
  readyPollMs?: number
  sleepMs?: (ms: number) => Promise<void>
  onLog?: (line: string) => void
  changeLedger?: Pick<ChangeLedger, 'recordStep'>
  changeId?: string
  /** Run-time parameter values for the playbook's declared params. */
  paramValues?: ParamValues
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const OUTPUT_TAIL = 4096
const tail = (s: string): string => (s.length > OUTPUT_TAIL ? s.slice(s.length - OUTPUT_TAIL) : s)

export interface OrchestratedRunRecord {
  runId: string
  playbookId: string
  playbookName: string
  startedAt: string
  endedAt?: string
  ok: boolean
  /** display-safe (secret-masked) param values used for this run. */
  params?: ParamValues
  targets: PlaybookTargetOutcome[]
}

/** Execute a playbook with the orchestrated (DAG/param/idempotent) engine. */
export async function executeOrchestratedPlaybook(
  deps: OrchestratedRunnerDeps,
  playbook: PlaybookEntry,
): Promise<OrchestratedRunRecord> {
  const log = deps.onLog ?? (() => {})
  const sleep = deps.sleepMs ?? defaultSleep
  const settings = deps.getSettings()
  const readyTimeoutMs = deps.readyTimeoutMs ?? 60_000
  const readyPollMs = deps.readyPollMs ?? 500

  // Resolve + substitute runbook params; keep a masked copy for the record.
  const paramVals = resolveParams(playbook.params, deps.paramValues ?? {})
  const maskedParams = maskSecrets(playbook.params, paramVals)

  // Pre-flight: the dependsOn graph must be valid before we touch any target.
  const plan = planDag(playbook.steps)
  const maxParallel = Math.max(1, playbook.maxParallelSteps ?? 1)

  const record: OrchestratedRunRecord = {
    runId: `run-${randomUUID()}`,
    playbookId: playbook.id,
    playbookName: playbook.name,
    startedAt: new Date().toISOString(),
    ok: false,
    targets: [],
  }
  if (Object.keys(maskedParams).length > 0) record.params = maskedParams

  const ledger = deps.changeLedger
  const changeId = deps.changeId
  const recordLedger = (target: string, s: { stepIndex: number; name?: string; kind: string }, phase: 'execute' | 'validate' | 'rollback', ok: boolean, detail?: string): void => {
    if (!ledger || !changeId) return
    try {
      ledger.recordStep({ changeId, target, stepIndex: s.stepIndex, stepName: s.name, kind: s.kind, phase, ok, detail })
    } catch { /* best-effort */ }
  }

  const scope = { groupId: playbook.groupId, tags: playbook.tags, targets: playbook.targets }
  const targets = resolveScheduledTaskTargets(scope, settings)

  const runTarget = async (name: string, config: TerminalConfig): Promise<PlaybookTargetOutcome> => {
    const outcome: PlaybookTargetOutcome = { target: name, ok: true, steps: [] }
    let terminalId: string | null = null
    // cross-host orchestration vars: start with params, add captures as steps run.
    const vars: Record<string, string> = { ...paramVals }
    // completed step indexes (for rollback ordering + DAG gating).
    const completed = new Set<number>()
    const failed = new Set<number>()

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

      // Execute the DAG in batches; steps within a batch run in parallel (capped).
      for (const batch of plan.batches) {
        for (const group of chunk(batch, maxParallel)) {
          // Run this chunk of steps concurrently.
          await Promise.all(group.map(async (i) => {
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
              // Idempotent desired-state check: skip when already satisfied.
              if (step.desiredState) {
                const skip = await checkDesiredState(step, async (checkCmd) => {
                  const r = await deps.terminalService.runCommandAndWait(terminalId!, substituteVars(checkCmd, vars))
                  return { stdout: r.stdoutDelta ?? '', exitCode: r.exitCode }
                })
                if (skip) {
                  stepOutcome.ok = true
                  stepOutcome.output = '[skipped: already in desired state]'
                  log(`[playbook] "${playbook.name}" @ ${name}: step ${i + 1} (${step.name ?? step.id}) skipped — desired state already met`)
                  completed.add(i)
                  return
                }
              }

              if (step.kind === 'wait') {
                await sleep(Math.max(0, (step.waitSeconds ?? 0) * 1000))
                completed.add(i)
                return
              }

              const rawCmd = resolvePlaybookStepCommand(step, deps.automationManager)!
              const command = substituteVars(rawCmd, vars)
              log(`[playbook] "${playbook.name}" @ ${name}: step ${i + 1}${step.name ? ` (${step.name})` : ''}`)
              const result = await deps.terminalService.runCommandAndWait(terminalId!, command)
              stepOutcome.exitCode = result.exitCode
              stepOutcome.output = tail(result.stdoutDelta ?? '')
              stepOutcome.ok = result.exitCode === 0 || result.exitCode === undefined
              if (!stepOutcome.ok) stepOutcome.error = `exit code ${result.exitCode}`
              recordLedger(name, stepOutcome, 'execute', stepOutcome.ok, stepOutcome.ok ? stepOutcome.output : stepOutcome.error)

              // capture cross-host orchestration variable from output.
              if (stepOutcome.ok && step.captureVar) {
                const v = captureVar(result.stdoutDelta ?? '', step.captureVar.pattern, step.captureVar.regex)
                if (v !== undefined) {
                  vars[step.captureVar.name] = v
                  log(`[playbook] "${playbook.name}" @ ${name}: captured ${step.captureVar.name}=${v}`)
                }
              }

              // post-step validation.
              if (stepOutcome.ok && step.validate) {
                try {
                  const checkCmd = substituteVars(resolveValidationCommand(step.validate, deps.automationManager), vars)
                  const check = await deps.terminalService.runCommandAndWait(terminalId!, checkCmd)
                  const matched = matchExpectation(check.stdoutDelta ?? '', step.validate.expect, step.validate.expectMode)
                  stepOutcome.validation = { ok: matched, ...(matched ? {} : { error: 'validation pattern not found in output' }) }
                  recordLedger(name, stepOutcome, 'validate', matched, matched ? undefined : `expect "${step.validate.expect}"`)
                  if (!matched) {
                    stepOutcome.ok = false
                    stepOutcome.error = `validation failed: expected "${step.validate.expect}" in check output`
                  }
                } catch (error) {
                  const msg = error instanceof Error ? error.message : String(error)
                  stepOutcome.validation = { ok: false, error: msg }
                  stepOutcome.ok = false
                  stepOutcome.error = `validation error: ${msg}`
                }
              }
            } catch (error) {
              stepOutcome.ok = false
              stepOutcome.error = error instanceof Error ? error.message : String(error)
              recordLedger(name, stepOutcome, 'execute', false, stepOutcome.error)
            }

            if (stepOutcome.ok) {
              completed.add(i)
            } else {
              failed.add(i)
              outcome.ok = false
              if (policy !== 'continue') {
                // stop this target's DAG here.
                log(`[playbook] "${playbook.name}" @ ${name}: step ${i + 1} failed (${stepOutcome.error}) — stopping target`)
              }
            }
          }))
          // If any step in the chunk failed with 'stop' policy, abort the target's remaining batches.
          const stopNow = group.some((i) => failed.has(i) && (playbook.steps[i].onError ?? playbook.onError ?? 'stop') === 'stop')
          if (stopNow) {
            await unwind(name, outcome, playbook, terminalId, completed, deps, log, recordLedger)
            return outcome
          }
        }
      }
      return outcome
    } catch (error) {
      outcome.ok = false
      outcome.error = error instanceof Error ? error.message : String(error)
      return outcome
    } finally {
      if (terminalId) {
        try { deps.terminalService.kill(terminalId) } catch { /* best-effort */ }
      }
    }
  }

  if (targets.length === 0) {
    log(`[playbook] "${playbook.name}": no target scope — running on the local shell`)
    record.targets.push(await runTarget('local', {
      type: 'local', id: `pb-${randomUUID()}`, title: `[playbook] ${playbook.name}`, cols: 120, rows: 32,
    } as TerminalConfig))
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
  try { deps.automationManager.markPlaybookRun(playbook.id, record.ok) } catch { /* best-effort */ }
  return record
}

/** Reverse-order rollback of completed steps for a stopped target. */
async function unwind(
  name: string,
  outcome: PlaybookTargetOutcome,
  playbook: PlaybookEntry,
  terminalId: string | null,
  completed: Set<number>,
  deps: OrchestratedRunnerDeps,
  log: (line: string) => void,
  recordLedger: (target: string, s: { stepIndex: number; name?: string; kind: string }, phase: 'execute' | 'validate' | 'rollback', ok: boolean, detail?: string) => void,
): Promise<void> {
  if (!terminalId) return
  outcome.rolledBack = true
  outcome.rollbackOk = true
  const ordered = Array.from(completed).sort((a, b) => b - a)
  for (const i of ordered) {
    const step = playbook.steps[i]
    if (!step.rollback) continue
    try {
      const cmd = step.rollback.kind === 'command'
        ? (step.rollback.command ?? '').trim()
        : (() => {
            const s = deps.automationManager.listScripts().find((x) => x.id === step.rollback!.scriptId)
            return (s?.command ?? '').trim()
          })()
      if (!cmd) continue
      const r = await deps.terminalService.runCommandAndWait(terminalId, cmd)
      const ok = r.exitCode === 0 || r.exitCode === undefined
      const so = outcome.steps.find((x) => x.stepIndex === i)
      if (so) { so.rolledBack = true; if (!ok) so.rollbackError = `rollback exit code ${r.exitCode}` }
      recordLedger(name, { stepIndex: i, name: step.name, kind: step.kind }, 'rollback', ok, ok ? undefined : `exit ${r.exitCode}`)
      if (!ok) outcome.rollbackOk = false
    } catch (e) {
      outcome.rollbackOk = false
      const so = outcome.steps.find((x) => x.stepIndex === i)
      if (so) { so.rolledBack = true; so.rollbackError = e instanceof Error ? e.message : String(e) }
    }
  }
  log(`[playbook] "${playbook.name}" @ ${name}: rollback ${outcome.rollbackOk ? 'completed' : 'completed WITH FAILURES'}`)
}
