import { randomUUID } from 'crypto'

/**
 * DriftDetector — Tier 4 SRE: config-drift detection.
 *
 * Periodically re-renders a config template for a device and diffs it against
 * the device's live config (fetched via an injected getter), reporting drift.
 * Optionally auto-remediates via a MOP change (injected proposeChange callback).
 * Pure + injectable: rendering + live-config fetching + remediation are injected.
 */

export interface DriftTarget {
  id: string
  name: string
  /** template id/name + values to render the expected config. */
  templateId: string
  /** the live-config fetch key (e.g. connection name / host). */
  host: string
  /** lines to ignore when diffing (timestamps, banners). */
  ignorePatterns?: string[]
}

export interface DriftLine {
  line: string
  kind: 'added' | 'removed'
}

export interface DriftResult {
  targetId: string
  at: number
  drifted: boolean
  added: DriftLine[]
  removed: DriftLine[]
  expectedHash: string
  actualHash: string
}

export interface DriftDeps {
  /** render the expected config for a template+target. */
  render: (target: DriftTarget) => Promise<string>
  /** fetch the device's live config. */
  getActual: (target: DriftTarget) => Promise<string>
  /** optional MOP change proposer for auto-remediation. */
  proposeChange?: (target: DriftTarget, result: DriftResult) => Promise<string>
  /** optional drift callback. */
  onDrift?: (result: DriftResult) => void
  now?: () => number
}

function normalize(text: string, ignorePatterns: string[] = []): string[] {
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim() !== '')
  const regexes = ignorePatterns.map((p) => { try { return new RegExp(p) } catch { return null } }).filter(Boolean) as RegExp[]
  return lines.filter((l) => !regexes.some((re) => re.test(l)))
}

function hash(lines: string[]): string {
  let h = 0
  const s = lines.join('\n')
  for (let i = 0; i < s.length; i += 1) { h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0 }
  return (h >>> 0).toString(36)
}

/** Line-level diff: lines in expected not in actual (removed) and vice versa (added). */
export function diffConfigs(expected: string[], actual: string[]): { added: DriftLine[]; removed: DriftLine[] } {
  const actualSet = new Set(actual)
  const expectedSet = new Set(expected)
  const removed: DriftLine[] = expected.filter((l) => !actualSet.has(l)).map((line) => ({ line, kind: 'removed' as const }))
  const added: DriftLine[] = actual.filter((l) => !expectedSet.has(l)).map((line) => ({ line, kind: 'added' as const }))
  return { added, removed }
}

export class DriftDetector {
  private readonly targets = new Map<string, DriftTarget>()
  private readonly lastResults = new Map<string, DriftResult>()
  private readonly now: () => number

  constructor(private readonly deps: DriftDeps) {
    this.now = deps.now ?? (() => Date.now())
  }

  upsert(target: Omit<DriftTarget, 'id'> & { id?: string }): DriftTarget {
    const t: DriftTarget = { ...target, id: target.id ?? `drift-${randomUUID().slice(0, 8)}` }
    this.targets.set(t.id, t)
    return t
  }

  remove(id: string): boolean {
    this.lastResults.delete(id)
    return this.targets.delete(id)
  }

  list(): readonly DriftTarget[] {
    return Array.from(this.targets.values())
  }

  lastResult(id: string): DriftResult | undefined {
    return this.lastResults.get(id)
  }

  /** Check one target for drift. Fires onDrift + optional proposeChange when drifted. */
  async check(id: string): Promise<DriftResult> {
    const t = this.targets.get(id)
    if (!t) throw new Error(`no drift target "${id}"`)
    const [expectedText, actualText] = await Promise.all([this.deps.render(t), this.deps.getActual(t)])
    const expected = normalize(expectedText, t.ignorePatterns)
    const actual = normalize(actualText, t.ignorePatterns)
    const { added, removed } = diffConfigs(expected, actual)
    const result: DriftResult = {
      targetId: id,
      at: this.now(),
      drifted: added.length > 0 || removed.length > 0,
      added,
      removed,
      expectedHash: hash(expected),
      actualHash: hash(actual),
    }
    this.lastResults.set(id, result)
    if (result.drifted) {
      try { this.deps.onDrift?.(result) } catch { /* best-effort */ }
      if (this.deps.proposeChange) {
        try { await this.deps.proposeChange(t, result) } catch { /* best-effort */ }
      }
    }
    return result
  }

  /** Check every target. */
  async checkAll(): Promise<DriftResult[]> {
    const out: DriftResult[] = []
    for (const id of this.targets.keys()) {
      out.push(await this.check(id))
    }
    return out
  }

  clear(): void {
    this.targets.clear()
    this.lastResults.clear()
  }
}
