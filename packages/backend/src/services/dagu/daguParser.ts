import { load as loadYaml } from 'js-yaml'
import { randomUUID } from 'crypto'
import type { PlaybookEntry, PlaybookStep } from '../../types'
import { planDag, validateDag } from '../automation/dagScheduler'

/**
 * daguParser — compile dagu YAML workflows into RTerm playbooks.
 *
 * dagu (github.com/dagucloud/dagu) is a declarative YAML DAG workflow engine.
 * This parser reads a dagu workflow document and compiles it into an RTerm
 * `PlaybookEntry` (which already supports dependsOn DAGs, onError, validation,
 * rollback, and retry), so dagu workflows run natively on RTerm's orchestrated
 * playbook runner — no dagu server needed.
 */

export interface DaguStep {
  id?: string
  name?: string
  run?: string
  command?: string
  cmd?: string
  call?: string
  script?: string
  depends?: string | string[]
  dir?: string
  output?: string
  continue_on?: string | boolean
  retry_policy?: { limit?: number; interval_sec?: number }
  preconditions?: string | Array<{ condition?: string; expected?: string }>
  executor?: string
}

export interface DaguDocument {
  name?: string
  description?: string
  schedule?: string
  params?: Record<string, string | { type?: string; description?: string; default?: string }>
  env?: Record<string, string>
  steps?: DaguStep[]
}

export interface DaguParseResult {
  playbook: PlaybookEntry
  /** warnings for unsupported/partially-supported fields. */
  warnings: string[]
}

function stepId(step: DaguStep, index: number): string {
  return (step.id ?? step.name ?? `step-${index + 1}`).toString().replace(/[^A-Za-z0-9_-]/g, '-')
}

function stepCommand(step: DaguStep): string {
  if (step.run) return step.run
  if (step.command) return step.command
  if (step.cmd) return step.cmd
  if (step.script) return `bash -c ${JSON.stringify(step.script)}`
  if (step.call) return `# call sub-workflow: ${step.call}`
  return 'true'
}

function stepDepends(step: DaguStep): string[] | undefined {
  if (!step.depends) return undefined
  return Array.isArray(step.depends) ? step.depends : [step.depends]
}

/** Compile a dagu workflow document into an RTerm PlaybookEntry. */
export function parseDaguWorkflow(doc: DaguDocument, opts: { name?: string; description?: string } = {}): DaguParseResult {
  const warnings: string[] = []
  const steps: PlaybookStep[] = []
  const rawSteps = Array.isArray(doc.steps) ? doc.steps : []

  if (rawSteps.length === 0) {
    warnings.push('No steps found in the dagu document.')
  }

  for (let i = 0; i < rawSteps.length; i += 1) {
    const s = rawSteps[i]
    const id = stepId(s, i)
    const command = stepCommand(s)
    const dependsOn = stepDepends(s)

    const step: PlaybookStep = {
      id,
      kind: 'command',
      command,
      ...(dependsOn ? { dependsOn } : {}),
    }
    if (s.name || s.id) step.name = s.name ?? s.id

    if (s.retry_policy?.limit && s.retry_policy.limit > 1) {
      warnings.push(`Step "${id}": retry_policy(limit=${s.retry_policy.limit}) noted — RTerm retries onError via the runbook engine.`)
    }

    if (s.continue_on === true || s.continue_on === 'continue' || s.continue_on === 'true') {
      step.onError = 'continue'
    }

    if (s.preconditions) {
      const conds = Array.isArray(s.preconditions) ? s.preconditions : [s.preconditions]
      const first = conds[0]
      if (typeof first === 'string') {
        step.desiredState = { command: first, expect: '0' }
        warnings.push(`Step "${id}": precondition mapped to a desiredState guard.`)
      } else if (first && typeof first === 'object' && first.condition) {
        step.desiredState = { command: first.condition, expect: first.expected ?? '0' }
      }
    }

    steps.push(step)
  }

  const dagError = validateDag(steps)
  if (dagError) {
    warnings.push(`DAG validation: ${dagError}`)
  }

  const params = doc.params
    ? Object.entries(doc.params).map(([name, def]) => {
        const d = typeof def === 'string' ? def : (def?.default ?? '')
        return { name, ...(d !== '' ? { defaultValue: d } : {}) }
      })
    : undefined

  const playbook: PlaybookEntry = {
    id: `dagu-${randomUUID().slice(0, 8)}`,
    name: opts.name ?? doc.name ?? 'dagu workflow',
    steps,
    ...(doc.description || opts.description ? { description: opts.description ?? doc.description } : {}),
    ...(params && params.length > 0 ? { params } : {}),
    maxParallelSteps: 4,
  }

  return { playbook, warnings }
}

/** Parse a dagu YAML string into an RTerm PlaybookEntry. */
export function parseDaguYaml(yamlText: string, opts: { name?: string; description?: string } = {}): DaguParseResult {
  const doc = loadYaml(yamlText) as DaguDocument
  if (!doc || typeof doc !== 'object') {
    throw new Error('Invalid dagu YAML: not a document')
  }
  return parseDaguWorkflow(doc, opts)
}

/** Summarize the execution order of a parsed dagu workflow (the DAG batches). */
export function daguExecutionPlan(playbook: PlaybookEntry): string {
  const plan = planDag(playbook.steps)
  const lines: string[] = []
  plan.batches.forEach((batch, i) => {
    const names = batch.map((idx) => playbook.steps[idx].name ?? playbook.steps[idx].id).join(', ')
    lines.push(`  [wave ${i + 1}] ${names}`)
  })
  return lines.join('\n')
}
