import type { PlaybookStep } from '../../types'

/**
 * DAG scheduler — order playbook steps respecting dependsOn graphs, detect
 * cycles and missing dependencies, and emit parallel-ready batches.
 *
 * Pure + unit-testable. A step with no dependsOn (or an empty one) depends on
 * the immediately-preceding step in declaration order (preserves today's
 * sequential behaviour); a step with dependsOn runs once every dependency has
 * completed successfully (or failed-with-continue, depending on the caller's
 * policy — completion, not success, gates scheduling).
 */

export interface DagPlan {
  /** Batches of step indexes that can run in parallel (order within a batch is
   * declaration order). Run batch 0, then batch 1, … */
  batches: number[][]
}

/** Build the parallel-ready execution batches for a set of steps.
 * Throws on a dependency cycle or a dependsOn reference to an unknown step id. */
export function planDag(steps: PlaybookStep[]): DagPlan {
  const n = steps.length
  const idToIndex = new Map<string, number>()
  steps.forEach((s, i) => idToIndex.set(s.id, i))

  // Build dependency lists (index -> array of dependency indexes).
  const deps: number[][] = steps.map((s, i) => {
    if (s.dependsOn !== undefined) {
      // Explicit list (even empty) overrides the linear default.
      return s.dependsOn.map((id) => {
        const di = idToIndex.get(id)
        if (di === undefined) {
          throw new Error(`Step "${s.name ?? s.id}" depends on unknown step id "${id}".`)
        }
        return di
      })
    }
    // No dependsOn declared: linear — depend on the previous step.
    return i > 0 ? [i - 1] : []
  })

  // Kahn's algorithm with batch grouping (nodes with in-degree 0 form a batch).
  const indegree = deps.map((d) => d.length)
  const dependents: number[][] = steps.map(() => [])
  deps.forEach((d, i) => d.forEach((dep) => dependents[dep].push(i)))

  const batches: number[][] = []
  const done = new Array<boolean>(n).fill(false)
  let doneCount = 0

  while (doneCount < n) {
    const batch: number[] = []
    for (let i = 0; i < n; i += 1) {
      if (!done[i] && indegree[i] === 0) batch.push(i)
    }
    if (batch.length === 0) {
      const remaining = steps
        .map((s, i) => (done[i] ? null : (s.name ?? s.id)))
        .filter(Boolean)
        .join(', ')
      throw new Error(`Dependency cycle detected in playbook steps: ${remaining}.`)
    }
    batches.push(batch)
    for (const i of batch) {
      done[i] = true
      doneCount += 1
      for (const dep of dependents[i]) {
        indegree[dep] -= 1
      }
    }
  }

  return { batches }
}

/** Split a batch into chunks of at most `size` (the maxParallelSteps cap). */
export function chunk<T>(arr: T[], size: number): T[][] {
  if (size <= 0) return [arr]
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/** Validate a dependsOn graph without planning (returns an error string or null). */
export function validateDag(steps: PlaybookStep[]): string | null {
  try {
    planDag(steps)
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}
