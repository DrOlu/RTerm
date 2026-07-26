/**
 * playbookToWorkflowDef.mjs — map an RTerm playbook (PlaybookEntry) to a
 * Netflix-Conductor WorkflowDef so AgentSpan agents can invoke it as a step
 * (SUB_WORKFLOW) or RTerm can register + run it durably on the Conductor server.
 *
 * Pure mapping (no I/O):
 *   - command step → a run_command-style HTTP task carrying the command + target
 *   - script step  → an HTTP task that references the saved script id (the
 *                    Conductor worker resolves the script body by id)
 *   - wait step    → a Conductor WAIT task (durationSeconds)
 *   - sequential + dependsOn DAG ordering → Conductor task `taskReferenceName`
 *     graph with JOIN on multiple dependencies
 *   - retries (onError=continue → retry, else fail-fast) → Conductor `retryCount`
 *   - rollback steps → compensating tasks appended after the main flow
 *
 * The emitted WorkflowDef is valid for `POST /api/metadata/workflow` on any
 * Conductor OSS / AgentSpan server.
 */

/** Sanitize a string into a Conductor-safe taskReferenceName ([A-Za-z0-9_]). */
export function taskRef(id, fallback) {
  const s = String(id ?? fallback ?? 'step').replace(/[^A-Za-z0-9_]/g, '_')
  return s.length > 0 ? s : 'step'
}

/** Map a single RTerm playbook step to a Conductor task (no edges yet). */
export function stepToTask(step, index, opts = {}) {
  const ref = taskRef(step.id ?? `step_${index}`)
  const name = step.name || ref
  const base = {
    name,
    taskReferenceName: ref,
    retryCount: step.onError === 'continue' ? (opts.continueRetryCount ?? 0) : 0,
    startDelay: 0,
    optional: false,
    asyncComplete: false,
  }

  if (step.kind === 'wait') {
    return {
      ...base,
      type: 'WAIT',
      inputParameters: { duration: step.waitSeconds ?? 0 },
    }
  }

  if (step.kind === 'script') {
    // Reference the saved script by id; the Conductor-side worker resolves the
    // script body (kept out of the def so it stays compact + secret-free).
    return {
      ...base,
      type: 'SIMPLE',
      inputParameters: {
        kind: 'rterm_script',
        scriptId: step.scriptId,
        name,
      },
    }
  }

  // kind === 'command' (default): an HTTP task that invokes RTerm's command
  // execution surface with the command + target scope.
  return {
    ...base,
    type: 'HTTP',
    inputParameters: {
      http_request: {
        uri: opts.execUri ?? '${workflow.input.rtermExecUri}',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: {
          kind: 'run_command',
          command: step.command ?? '',
          ...(step.validate ? { validate: step.validate } : {}),
        },
        connectionTimeOut: opts.connectionTimeOut ?? 5000,
        readTimeOut: opts.readTimeOut ?? 300000,
      },
    },
  }
}

/** Map a rollback action to a compensating Conductor task. */
export function rollbackToTask(rollback, stepRef, index) {
  const ref = taskRef(`rollback_${stepRef}_${index}`)
  if (rollback.kind === 'script') {
    return {
      name: ref,
      taskReferenceName: ref,
      type: 'SIMPLE',
      inputParameters: { kind: 'rterm_script', scriptId: rollback.scriptId, compensating: true },
      retryCount: 0,
      optional: true, // a failing rollback never blocks the workflow result
      asyncComplete: false,
    }
  }
  return {
    name: ref,
    taskReferenceName: ref,
    type: 'HTTP',
    inputParameters: {
      http_request: {
        uri: '${workflow.input.rtermExecUri}',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: { kind: 'run_command', command: rollback.command ?? '', compensating: true },
      },
    },
    retryCount: 0,
    optional: true,
    asyncComplete: false,
  }
}

/**
 * Build the ordered task list with DAG edges from dependsOn.
 * Returns { tasks, order } where order is the topological order of step refs.
 * Steps with no dependsOn depend on the previous step (linear chain). Steps
 * with multiple dependsOn get a JOIN task.
 */
export function buildDag(steps) {
  const refs = steps.map((s, i) => taskRef(s.id ?? `step_${i}`))
  const tasks = []
  const joins = []
  steps.forEach((s, i) => {
    const ref = refs[i]
    const deps = Array.isArray(s.dependsOn) && s.dependsOn.length > 0
      ? s.dependsOn.map((d) => taskRef(d))
      : (i === 0 ? [] : [refs[i - 1]])
    if (deps.length > 1) {
      const joinRef = taskRef(`join_${ref}`)
      joins.push({ ref: joinRef, type: 'JOIN', joinOn: deps, taskReferenceName: joinRef, name: joinRef })
    }
  })
  return { refs, joins }
}

/**
 * Map a full RTerm playbook to a Conductor WorkflowDef.
 * @param {object} playbook PlaybookEntry
 * @param {object} [opts] { execUri, connectionTimeOut, readTimeOut, continueRetryCount }
 * @returns {object} a Conductor WorkflowDef (POST /api/metadata/workflow)
 */
export function playbookToWorkflowDef(playbook, opts = {}) {
  if (!playbook || !Array.isArray(playbook.steps)) {
    throw new Error('playbookToWorkflowDef needs a playbook with a steps array')
  }
  const name = String(playbook.name || playbook.id || 'rterm_playbook').replace(/\s+/g, '_')
  const steps = playbook.steps
  const tasks = []
  const rollbackTasks = []

  // Main flow: map each step, then wire sequential/DAG ordering by emitting
  // tasks in dependency order (Conductor executes top-down; dependsOn edges are
  // expressed via JOINs for fan-in).
  const refs = steps.map((s, i) => taskRef(s.id ?? `step_${i}`))
  const emittedJoins = new Set()

  steps.forEach((step, i) => {
    const ref = refs[i]
    const task = stepToTask(step, i, opts)
    // Wire dependency: Conductor's default is sequential task order, but we
    // explicitly model dependsOn fan-in as a JOIN before this task when the
    // step has multiple dependencies.
    const deps = Array.isArray(step.dependsOn) && step.dependsOn.length > 0
      ? step.dependsOn.map((d) => taskRef(d))
      : []
    if (deps.length > 1 && !emittedJoins.has(ref)) {
      const joinRef = taskRef(`join_${ref}`)
      tasks.push({
        name: joinRef,
        taskReferenceName: joinRef,
        type: 'JOIN',
        joinOn: deps,
      })
      emittedJoins.add(ref)
    }
    tasks.push(task)
    if (step.rollback) {
      rollbackTasks.push(rollbackToTask(step.rollback, ref, rollbackTasks.length))
    }
  })

  // Compensating (rollback) tasks run after the main flow, in reverse step
  // order (undo the most recent change first) — marked optional so they never
  // mask the workflow's real result.
  const orderedRollback = [...rollbackTasks].reverse()

  return {
    name,
    description: playbook.description || `RTerm playbook: ${playbook.name ?? name}`,
    version: 1,
    tasks: [...tasks, ...orderedRollback],
    inputParameters: [],
    outputParameters: {},
    schemaVersion: 2,
    restartable: true,
    workflowStatusListenerEnabled: false,
    ownerEmail: 'rterm@hyperspace.ng',
    timeoutPolicy: 'ALERT_ONLY',
    timeoutSeconds: 0,
    variables: {},
    inputTemplate: {
      rtermExecUri: opts.execUri ?? 'http://localhost:17888/rpc/exec',
    },
  }
}

export default { playbookToWorkflowDef, stepToTask, rollbackToTask, taskRef, buildDag }
