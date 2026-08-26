/**
 * subAgent — spawn child agent sessions for parallel/scoped work (v3.2.18).
 *
 * The agent loop is linear: "check all 6 servers and summarize" goes one at a
 * time. This module lets the model fan work out to child sessions that run
 * concurrently, each with a scoped prompt, and collect their results.
 *
 * Pure + injectable: the planner and collector are testable without any LLM.
 * The caller wires `runChild` to AgentService.startTask on a fresh session.
 */

export interface SubAgentTask {
  /** short label for reporting */
  label: string
  /** the prompt for the child */
  prompt: string
}

export interface SubAgentSpec {
  /** the tasks to fan out */
  tasks: SubAgentTask[]
  /** max children running concurrently (default 3) */
  maxConcurrent?: number
  /** per-child timeout ms (default 300_000 = 5 min) */
  timeoutMs?: number
}

export interface SubAgentResult {
  label: string
  ok: boolean
  /** the child's final answer text */
  output?: string
  error?: string
  durationMs: number
  timedOut: boolean
}

export interface SubAgentSummary {
  ok: boolean
  total: number
  succeeded: number
  failed: number
  results: SubAgentResult[]
}

/** Validate a sub-agent spec before spawning anything. */
export function validateSubAgentSpec(spec: unknown): { ok: boolean; error?: string } {
  if (!spec || typeof spec !== 'object') return { ok: false, error: 'spec must be an object' }
  const s = spec as { tasks?: unknown; maxConcurrent?: unknown; timeoutMs?: unknown }
  if (!Array.isArray(s.tasks) || s.tasks.length === 0) {
    return { ok: false, error: 'tasks must be a non-empty array' }
  }
  if (s.tasks.length > 20) {
    return { ok: false, error: `too many tasks (${s.tasks.length}); max 20 per fan-out` }
  }
  for (let i = 0; i < s.tasks.length; i++) {
    const t = s.tasks[i] as { label?: unknown; prompt?: unknown }
    if (!t || typeof t !== 'object') return { ok: false, error: `task ${i + 1} must be an object` }
    if (typeof t.prompt !== 'string' || !t.prompt.trim()) {
      return { ok: false, error: `task ${i + 1} needs a non-empty prompt` }
    }
    if (t.label !== undefined && typeof t.label !== 'string') {
      return { ok: false, error: `task ${i + 1} label must be a string` }
    }
  }
  if (s.maxConcurrent !== undefined && (!Number.isFinite(s.maxConcurrent) || (s.maxConcurrent as number) < 1)) {
    return { ok: false, error: 'maxConcurrent must be >= 1' }
  }
  if (s.timeoutMs !== undefined && (!Number.isFinite(s.timeoutMs) || (s.timeoutMs as number) < 1000)) {
    return { ok: false, error: 'timeoutMs must be >= 1000' }
  }
  return { ok: true }
}

export type SubAgentRunner = (task: SubAgentTask) => Promise<string>

/** Run one child with a timeout. */
async function runWithTimeout(
  task: SubAgentTask,
  run: SubAgentRunner,
  timeoutMs: number,
): Promise<SubAgentResult> {
  const started = Date.now()
  return await new Promise<SubAgentResult>((resolve) => {
    let settled = false
    const finish = (r: SubAgentResult) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r) } }
    const timer = setTimeout(() => {
      finish({ label: task.label, ok: false, error: 'timed out', durationMs: Date.now() - started, timedOut: true })
    }, timeoutMs)
    run(task)
      .then((output) => finish({ label: task.label, ok: true, output, durationMs: Date.now() - started, timedOut: false }))
      .catch((e) => finish({
        label: task.label,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        durationMs: Date.now() - started,
        timedOut: false,
      }))
  })
}

/**
 * Fan out the tasks with a concurrency cap, collect all results.
 * Never throws: failures become failed results.
 */
export async function runSubAgents(
  spec: SubAgentSpec,
  run: SubAgentRunner,
): Promise<SubAgentSummary> {
  const maxConcurrent = Math.max(1, spec.maxConcurrent ?? 3)
  const timeoutMs = spec.timeoutMs ?? 300_000
  const results: SubAgentResult[] = []

  for (let i = 0; i < spec.tasks.length; i += maxConcurrent) {
    const batch = spec.tasks.slice(i, i + maxConcurrent)
    const batchResults = await Promise.all(
      batch.map((t) => runWithTimeout(t, run, timeoutMs)),
    )
    results.push(...batchResults)
  }

  const succeeded = results.filter((r) => r.ok).length
  return {
    ok: succeeded === results.length,
    total: results.length,
    succeeded,
    failed: results.length - succeeded,
    results,
  }
}

/** Render a summary for the parent agent to read. */
export function renderSubAgentSummary(summary: SubAgentSummary): string {
  const lines = [
    `Sub-agent fan-out: ${summary.succeeded}/${summary.total} succeeded.`,
    '',
  ]
  for (const r of summary.results) {
    const status = r.ok ? '✓' : (r.timedOut ? '⏱' : '✗')
    const detail = r.ok
      ? (r.output ?? '').slice(0, 400)
      : `${r.error ?? 'failed'}${r.timedOut ? ` (after ${Math.round(r.durationMs / 1000)}s)` : ''}`
    lines.push(`${status} ${r.label}: ${detail}`)
    lines.push('')
  }
  if (summary.failed > 0) {
    lines.push(`${summary.failed} task(s) failed — consider retrying those individually.`)
  }
  return lines.join('\n')
}
