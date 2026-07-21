import { randomUUID } from 'crypto'

/**
 * EvalHarness — embedded evals for RTerm's agent performance, safety, and reliability.
 *
 * Runs a golden set of eval cases against the agent (or a mock agent) and scores:
 *   - task accuracy      (does the agent produce the right answer/action)
 *   - tool selection     (does it pick the right tool)
 *   - safety/policy      (does it refuse dangerous operations)
 *   - determinism        (replay: same tool sequence as a recorded golden run)
 * and aggregates a reliability report (accuracy %, tool %, safety %, pass/fail).
 *
 * Pure + injectable: the agent runner and policy checker are injected, so evals
 * run offline (deterministic mock) or online (real model). Deterministic `now`.
 */

export type EvalKind = 'accuracy' | 'tool-selection' | 'safety' | 'replay'

export interface EvalCase {
  id: string
  kind: EvalKind
  /** the user prompt (or replay transcript id). */
  prompt: string
  /** accuracy/tool: expected substring in the final answer. */
  expectAnswerContains?: string
  /** tool-selection: expected tool name(s) the agent should call. */
  expectTools?: string[]
  /** safety: a command that MUST be blocked by policy (deny). */
  expectBlockedCommand?: string
  /** replay: expected ordered tool sequence. */
  expectToolSequence?: string[]
  tags?: string[]
}

export interface EvalResult {
  caseId: string
  kind: EvalKind
  pass: boolean
  reason: string
  /** tokens used (when the runner reports them). */
  tokens?: number
  latencyMs?: number
}

export interface EvalReport {
  id: string
  at: number
  total: number
  passed: number
  failed: number
  accuracyPct?: number
  toolSelectionPct?: number
  safetyPct?: number
  replayPct?: number
  results: EvalResult[]
}

export interface AgentRunOutput {
  answer: string
  toolsCalled: string[]
  tokens?: number
}

export interface EvalDeps {
  /** run a prompt through the agent; returns the final answer + tools called. */
  runAgent: (prompt: string) => Promise<AgentRunOutput>
  /** check whether a command is blocked by policy (deny). Injected for safety evals. */
  isCommandBlocked?: (command: string) => boolean
  now?: () => number
}

function subset<T>(needles: T[], haystack: T[]): boolean {
  return needles.every((n) => haystack.includes(n))
}

export class EvalHarness {
  private readonly now: () => number

  constructor(private readonly deps: EvalDeps) {
    this.now = deps.now ?? (() => Date.now())
  }

  /** Run one eval case. */
  async runCase(c: EvalCase): Promise<EvalResult> {
    const startedAt = this.now()
    try {
      switch (c.kind) {
        case 'accuracy':
        case 'tool-selection': {
          const out = await this.deps.runAgent(c.prompt)
          const tokens = out.tokens
          const latencyMs = this.now() - startedAt
          if (c.kind === 'accuracy') {
            const need = c.expectAnswerContains ?? ''
            const pass = need === '' ? true : out.answer.toLowerCase().includes(need.toLowerCase())
            return { caseId: c.id, kind: c.kind, pass, reason: pass ? 'answer matched' : `answer missing "${need}"`, ...(tokens !== undefined ? { tokens } : {}), latencyMs }
          }
          const tools = c.expectTools ?? []
          const pass = subset(tools, out.toolsCalled)
          return { caseId: c.id, kind: c.kind, pass, reason: pass ? 'tools matched' : `expected tools ${JSON.stringify(tools)}, got ${JSON.stringify(out.toolsCalled)}`, ...(tokens !== undefined ? { tokens } : {}), latencyMs }
        }
        case 'safety': {
          const cmd = c.expectBlockedCommand ?? ''
          if (!cmd) return { caseId: c.id, kind: c.kind, pass: false, reason: 'no expectBlockedCommand provided', latencyMs: 0 }
          if (!this.deps.isCommandBlocked) {
            return { caseId: c.id, kind: c.kind, pass: false, reason: 'no policy checker injected', latencyMs: 0 }
          }
          const blocked = this.deps.isCommandBlocked(cmd)
          return { caseId: c.id, kind: c.kind, pass: blocked, reason: blocked ? 'blocked as required' : `command NOT blocked: ${cmd}`, latencyMs: this.now() - startedAt }
        }
        case 'replay': {
          const out = await this.deps.runAgent(c.prompt)
          const expected = c.expectToolSequence ?? []
          const pass = JSON.stringify(out.toolsCalled) === JSON.stringify(expected)
          return { caseId: c.id, kind: c.kind, pass, reason: pass ? 'sequence matched' : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(out.toolsCalled)}`, latencyMs: this.now() - startedAt }
        }
        default:
          return { caseId: c.id, kind: c.kind, pass: false, reason: `unknown eval kind ${(c as { kind: string }).kind}`, latencyMs: 0 }
      }
    } catch (e) {
      return { caseId: c.id, kind: c.kind, pass: false, reason: `error: ${e instanceof Error ? e.message : String(e)}`, latencyMs: this.now() - startedAt }
    }
  }

  /** Run a golden set and produce the aggregate report. */
  async runEval(cases: EvalCase[]): Promise<EvalReport> {
    const results: EvalResult[] = []
    for (const c of cases) {
      results.push(await this.runCase(c))
    }
    const passed = results.filter((r) => r.pass).length
    const byKind = (kind: EvalKind) => {
      const arr = results.filter((r) => r.kind === kind)
      return arr.length > 0 ? (arr.filter((r) => r.pass).length / arr.length) * 100 : undefined
    }
    return {
      id: `eval-${randomUUID().slice(0, 8)}`,
      at: this.now(),
      total: results.length,
      passed,
      failed: results.length - passed,
      accuracyPct: byKind('accuracy'),
      toolSelectionPct: byKind('tool-selection'),
      safetyPct: byKind('safety'),
      replayPct: byKind('replay'),
      results,
    }
  }
}
