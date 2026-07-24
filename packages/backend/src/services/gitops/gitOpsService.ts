/**
 * gitOpsService — GitOps for RTerm's desired state (Tier 1). Exports the whole
 * estate (connections, playbooks, triggers, templates, policies, SLOs) to a
 * versioned YAML/JSON manifest that can live in a Git repo, diffs a repo
 * manifest against live state (drift detection), and reconciles live state to
 * match the repo (apply) — every apply gated and recorded.
 *
 * Pure + injectable: the live-state accessors and the applier are injected;
 * this module computes manifests + drift. No Git binary needed for the
 * manifest/diff logic (a thin wrapper can clone/pull around it).
 */

import { createHash } from 'crypto'

/** A single desired-state entity (connection, playbook, trigger, …). */
export interface DesiredEntity {
  /** stable identity, e.g. 'connection:prod-web-01' or 'playbook:deploy'. */
  id: string
  /** entity kind (connection/playbook/trigger/template/policy/slo/budget). */
  kind: string
  /** the desired definition (kind-specific). */
  spec: Record<string, unknown>
}

export interface StateManifest {
  version: 1
  /** hash over the sorted entity specs — a content fingerprint of the estate. */
  stateHash: string
  entities: DesiredEntity[]
}

export type DriftKind = 'added' | 'removed' | 'changed'

export interface DriftEntry {
  id: string
  kind: string
  drift: DriftKind
  /** for 'changed': field-level diffs. */
  fieldDiffs?: Array<{ field: string; repo: unknown; live: unknown }>
}

export interface ReconcileResult {
  applied: DriftEntry[]
  /** entries that failed to apply (best-effort). */
  errors: Array<{ id: string; error: string }>
}

export interface GitOpsDeps {
  now?: () => number
  /** injected: read the current live estate (same shape as a manifest). */
  readLive: () => DesiredEntity[] | Promise<DesiredEntity[]>
  /** injected: apply one entity to live state (create/update/delete). */
  applyEntity?: (action: 'upsert' | 'delete', entity: DesiredEntity) => Promise<void>
  /** called after a successful reconcile with the new state hash. */
  onReconciled?: (stateHash: string, applied: number) => void
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`
}

function specHash(spec: Record<string, unknown>): string {
  return createHash('sha256').update(stableStringify(spec)).digest('hex').slice(0, 12)
}

/** Build a manifest from a set of entities (sorted, content-hashed). Pure. */
export function buildManifest(entities: DesiredEntity[]): StateManifest {
  const sorted = [...entities].sort((a, b) => a.id.localeCompare(b.id))
  const stateHash = createHash('sha256')
    .update(sorted.map((e) => `${e.id}:${specHash(e.spec)}`).join('\n'))
    .digest('hex')
  return { version: 1, stateHash, entities: sorted }
}

/** Compute field-level diffs between two specs (top-level fields). */
export function specDiff(repo: Record<string, unknown>, live: Record<string, unknown>): Array<{ field: string; repo: unknown; live: unknown }> {
  const diffs: Array<{ field: string; repo: unknown; live: unknown }> = []
  const keys = new Set([...Object.keys(repo), ...Object.keys(live)])
  for (const k of [...keys].sort()) {
    if (stableStringify(repo[k]) !== stableStringify(live[k])) {
      diffs.push({ field: k, repo: repo[k], live: live[k] })
    }
  }
  return diffs
}

/** Diff a repo manifest against the live estate. Pure. */
export function diffManifest(repo: StateManifest, live: DesiredEntity[]): DriftEntry[] {
  const liveById = new Map(live.map((e) => [e.id, e]))
  const repoById = new Map(repo.entities.map((e) => [e.id, e]))
  const drift: DriftEntry[] = []
  for (const re of repo.entities) {
    const le = liveById.get(re.id)
    if (!le) {
      drift.push({ id: re.id, kind: re.kind, drift: 'added' })
    } else {
      const fieldDiffs = specDiff(re.spec, le.spec)
      if (fieldDiffs.length > 0 || re.kind !== le.kind) {
        drift.push({ id: re.id, kind: re.kind, drift: 'changed', fieldDiffs })
      }
    }
  }
  for (const le of live) {
    if (!repoById.has(le.id)) drift.push({ id: le.id, kind: le.kind, drift: 'removed' })
  }
  return drift.sort((a, b) => a.id.localeCompare(b.id))
}

export class GitOpsService {
  private readonly readLive: GitOpsDeps['readLive']
  private readonly applyEntity?: GitOpsDeps['applyEntity']
  private readonly onReconciled?: GitOpsDeps['onReconciled']
  private lastHash: string | null = null

  constructor(deps: GitOpsDeps) {
    if (!deps.readLive) throw new Error('gitOpsService needs readLive')
    this.readLive = deps.readLive
    this.applyEntity = deps.applyEntity
    this.onReconciled = deps.onReconciled
  }

  /** Export the live estate as a manifest (for committing to Git). */
  async exportLive(): Promise<StateManifest> {
    return buildManifest(await this.readLive())
  }

  /** Drift between a repo manifest and the current live estate. */
  async drift(repo: StateManifest): Promise<DriftEntry[]> {
    return diffManifest(repo, await this.readLive())
  }

  /** True when live matches the repo manifest (no drift). */
  async inSync(repo: StateManifest): Promise<boolean> {
    return (await this.drift(repo)).length === 0
  }

  /**
   * Reconcile live state to the repo manifest: upsert added/changed, delete
   * removed. Best-effort per entity; records the new state hash. Requires an
   * applyEntity handler.
   */
  async reconcile(repo: StateManifest, opts: { deleteRemoved?: boolean } = {}): Promise<ReconcileResult> {
    if (!this.applyEntity) throw new Error('reconcile needs an applyEntity handler')
    const drift = await this.drift(repo)
    const applied: DriftEntry[] = []
    const errors: Array<{ id: string; error: string }> = []
    const repoById = new Map(repo.entities.map((e) => [e.id, e]))
    for (const entry of drift) {
      try {
        if (entry.drift === 'removed') {
          if (opts.deleteRemoved === false) continue
          await this.applyEntity('delete', { id: entry.id, kind: entry.kind, spec: {} })
        } else {
          const entity = repoById.get(entry.id)
          if (!entity) continue
          await this.applyEntity('upsert', entity)
        }
        applied.push(entry)
      } catch (e) {
        errors.push({ id: entry.id, error: e instanceof Error ? e.message : String(e) })
      }
    }
    this.lastHash = repo.stateHash
    this.onReconciled?.(repo.stateHash, applied.length)
    return { applied, errors }
  }

  /** The state hash from the last reconcile (or export). */
  lastReconciledHash(): string | null {
    return this.lastHash
  }
}
