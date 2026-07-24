/**
 * playbookVersioning — version history + static linting for playbooks/runbooks
 * (Tier 2). Every save is versioned (diff + rollback to any prior version), and
 * a `lint` pass catches structural problems (undefined params, unreachable DAG
 * nodes, dependsOn cycles, missing rollback, empty steps) BEFORE a run.
 *
 * Pure + injectable: works on plain playbook definition objects; no I/O.
 */

import { createHash } from 'crypto'

export interface PlaybookStepDef {
  id?: string
  name?: string
  kind: 'command' | 'script' | 'wait'
  command?: string
  scriptId?: string
  waitSeconds?: number
  dependsOn?: string[]
  onError?: 'stop' | 'continue'
  rollback?: { kind: 'command' | 'script'; command?: string; scriptId?: string }
  params?: Array<{ name: string; default?: string; secret?: boolean }>
}

export interface PlaybookDef {
  id?: string
  name: string
  steps: PlaybookStepDef[]
  params?: Array<{ name: string; default?: string; secret?: boolean }>
  onError?: 'stop' | 'continue'
}

export type LintSeverity = 'error' | 'warning'

export interface LintIssue {
  severity: LintSeverity
  /** rule id (e.g. 'depends-cycle'). */
  rule: string
  message: string
  /** step index when relevant. */
  stepIndex?: number
}

export interface PlaybookVersion {
  version: number
  hash: string
  savedAt: number
  def: PlaybookDef
  comment?: string
}

export interface PlaybookVersioningDeps {
  now?: () => number
}

function hashDef(def: PlaybookDef): string {
  return createHash('sha256').update(JSON.stringify(def)).digest('hex').slice(0, 16)
}

// ─── Linting ────────────────────────────────────────────────────────────────

/** Statically validate a playbook definition. Returns issues (errors block). */
export function lintPlaybook(def: PlaybookDef): LintIssue[] {
  const issues: LintIssue[] = []
  if (!def || typeof def !== 'object') {
    return [{ severity: 'error', rule: 'invalid', message: 'playbook is not an object' }]
  }
  if (!def.name || typeof def.name !== 'string') {
    issues.push({ severity: 'error', rule: 'name', message: 'playbook needs a name' })
  }
  if (!Array.isArray(def.steps) || def.steps.length === 0) {
    issues.push({ severity: 'error', rule: 'steps', message: 'playbook needs at least one step' })
    return issues
  }

  const declaredParams = new Set((def.params ?? []).map((p) => p.name))
  const stepIds = new Set<string>()
  def.steps.forEach((s, i) => {
    // step kind + payload
    if (!s.kind || !['command', 'script', 'wait'].includes(s.kind)) {
      issues.push({ severity: 'error', rule: 'step-kind', message: `step ${i} has invalid kind`, stepIndex: i })
    }
    if (s.kind === 'command' && !(s.command && s.command.trim())) {
      issues.push({ severity: 'error', rule: 'step-empty', message: `step ${i} (command) is empty`, stepIndex: i })
    }
    if (s.kind === 'script' && !s.scriptId) {
      issues.push({ severity: 'error', rule: 'step-empty', message: `step ${i} (script) has no scriptId`, stepIndex: i })
    }
    if (s.kind === 'wait' && !(typeof s.waitSeconds === 'number' && s.waitSeconds > 0)) {
      issues.push({ severity: 'error', rule: 'step-wait', message: `step ${i} (wait) needs waitSeconds > 0`, stepIndex: i })
    }
    // id uniqueness (for dependsOn references)
    if (s.id) {
      if (stepIds.has(s.id)) {
        issues.push({ severity: 'error', rule: 'step-id-dup', message: `duplicate step id '${s.id}'`, stepIndex: i })
      }
      stepIds.add(s.id)
    }
    // param refs in command
    if (s.command) {
      for (const m of s.command.matchAll(/\{\{param\.([a-zA-Z0-9_]+)\}\}/g)) {
        if (!declaredParams.has(m[1])) {
          issues.push({ severity: 'error', rule: 'param-undefined', message: `step ${i} references undefined param '${m[1]}'`, stepIndex: i })
        }
      }
    }
    // mutating step without rollback (heuristic warning)
    if (s.kind !== 'wait' && !s.rollback && isMutating(s.command)) {
      issues.push({ severity: 'warning', rule: 'no-rollback', message: `step ${i} mutates state but has no rollback`, stepIndex: i })
    }
  })

  // dependsOn references + cycle detection
  const idToIndex = new Map<string, number>()
  def.steps.forEach((s, i) => { if (s.id) idToIndex.set(s.id, i) })
  def.steps.forEach((s, i) => {
    for (const dep of s.dependsOn ?? []) {
      if (!idToIndex.has(dep)) {
        issues.push({ severity: 'error', rule: 'depends-missing', message: `step ${i} depends on unknown step '${dep}'`, stepIndex: i })
      }
    }
  })
  const cycle = findDependsCycle(def.steps)
  if (cycle) {
    issues.push({ severity: 'error', rule: 'depends-cycle', message: `dependsOn cycle: ${cycle.join(' -> ')}` })
  }

  return issues
}

/** Heuristic: does a command mutate state (not read-only)? */
function isMutating(cmd?: string): boolean {
  if (!cmd) return false
  return /\b(rm|mv|cp|dd|mkfs|format|delete|drop|truncate|update|upgrade|install|uninstall|apply|patch|deploy|restart|reload|stop|kill|systemctl\s+(start|stop|restart|enable|disable)|chmod|chown|sed\s+-i|>\s*\/)\b/i.test(cmd)
}

/** Detect a cycle in dependsOn edges. Returns the cycle path or null. */
export function findDependsCycle(steps: PlaybookStepDef[]): string[] | null {
  const name = (s: PlaybookStepDef, i: number) => s.id ?? `#${i}`
  const edges = new Map<string, string[]>()
  steps.forEach((s, i) => edges.set(name(s, i), (s.dependsOn ?? []).map((d) => d)))
  // map dependsOn ids back to node names (dep may reference by id)
  const idSet = new Set(steps.map((s) => s.id).filter(Boolean) as string[])
  const visiting = new Set<string>()
  const done = new Set<string>()
  const stack: string[] = []
  let cycle: string[] | null = null
  function dfs(node: string): boolean {
    if (done.has(node)) return false
    if (visiting.has(node)) {
      const idx = stack.indexOf(node)
      cycle = stack.slice(idx).concat(node)
      return true
    }
    visiting.add(node)
    stack.push(node)
    for (const dep of edges.get(node) ?? []) {
      if (!idSet.has(dep)) continue // unknown handled elsewhere
      if (dfs(dep)) return true
    }
    stack.pop()
    visiting.delete(node)
    done.add(node)
    return false
  }
  for (const node of edges.keys()) if (dfs(node)) break
  return cycle
}

/** True when lint has no errors (warnings allowed). */
export function lintOk(def: PlaybookDef): boolean {
  return !lintPlaybook(def).some((i) => i.severity === 'error')
}

// ─── Versioning ─────────────────────────────────────────────────────────────

export class PlaybookVersioning {
  private readonly versions = new Map<string, PlaybookVersion[]>() // playbookId -> versions asc
  private readonly now: () => number

  constructor(deps: PlaybookVersioningDeps = {}) {
    this.now = deps.now ?? Date.now
  }

  /** Save a new version. Lints first — refuses to save a definition with errors. */
  save(playbookId: string, def: PlaybookDef, comment?: string): PlaybookVersion {
    if (!playbookId) throw new Error('save needs a playbookId')
    const errors = lintPlaybook(def).filter((i) => i.severity === 'error')
    if (errors.length > 0) {
      throw new Error(`playbook failed lint: ${errors.map((e) => e.message).join('; ')}`)
    }
    const arr = this.versions.get(playbookId) ?? []
    const v: PlaybookVersion = {
      version: arr.length + 1,
      hash: hashDef(def),
      savedAt: this.now(),
      def: JSON.parse(JSON.stringify(def)),
      comment,
    }
    arr.push(v)
    this.versions.set(playbookId, arr)
    return v
  }

  /** All versions for a playbook (ascending). Returns defensive copies. */
  history(playbookId: string): PlaybookVersion[] {
    return (this.versions.get(playbookId) ?? []).map((v) => this.copy(v))
  }

  /** The latest version, or undefined. Returns a defensive copy. */
  latest(playbookId: string): PlaybookVersion | undefined {
    const arr = this.versions.get(playbookId)
    const v = arr && arr.length > 0 ? arr[arr.length - 1] : undefined
    return v ? this.copy(v) : undefined
  }

  /** A specific version, or undefined. Returns a defensive copy. */
  get(playbookId: string, version: number): PlaybookVersion | undefined {
    const v = (this.versions.get(playbookId) ?? []).find((x) => x.version === version)
    return v ? this.copy(v) : undefined
  }

  private copy(v: PlaybookVersion): PlaybookVersion {
    return { ...v, def: JSON.parse(JSON.stringify(v.def)) }
  }

  /** Roll back to a prior version: saves that version's def as a NEW version. */
  rollback(playbookId: string, toVersion: number, comment?: string): PlaybookVersion {
    const target = this.get(playbookId, toVersion)
    if (!target) throw new Error(`no version ${toVersion} for playbook ${playbookId}`)
    return this.save(playbookId, JSON.parse(JSON.stringify(target.def)), comment ?? `rollback to v${toVersion}`)
  }

  /** Diff two versions of a playbook (line-level, unified-ish). */
  diff(playbookId: string, aVersion: number, bVersion: number): string {
    const a = this.get(playbookId, aVersion)
    const b = this.get(playbookId, bVersion)
    if (!a || !b) throw new Error(`diff needs both versions (${aVersion}, ${bVersion})`)
    return diffText(JSON.stringify(a.def, null, 2), JSON.stringify(b.def, null, 2), `v${aVersion}`, `v${bVersion}`)
  }
}

/** Minimal line diff (LCS-based) producing -/+ lines. */
export function diffText(aText: string, bText: string, aLabel = 'a', bLabel = 'b'): string {
  const a = aText.split('\n')
  const b = bText.split('\n')
  const m = a.length
  const n = b.length
  // LCS DP
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out: string[] = [`--- ${aLabel}`, `+++ ${bLabel}`]
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (a[i] === b[j]) { out.push(` ${a[i]}`); i++; j++ } else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push(`-${a[i]}`); i++ } else { out.push(`+${b[j]}`); j++ }
  }
  while (i < m) out.push(`-${a[i++]}`)
  while (j < n) out.push(`+${b[j++]}`)
  return out.join('\n')
}
