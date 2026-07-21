import type { AgentRunRecord } from '../agentRunLedger'

/**
 * BehaviorLedger — behavioral analytics (UEBA-style) over agent run + usage data.
 *
 * Builds baselines of normal behavior (run frequency, token usage, error rate,
 * per-model usage) and flags deviations: an unusual spike in runs, a token
 * blowout, an abnormal error rate, or a new/unusual model. Dependency-free,
 * deterministic, and reads from injected run records (the agentRunLedger data).
 */

export interface RunEvent {
  at: number
  sessionId: string
  model?: string
  status: string
  promptTokens: number
  completionTokens: number
}

export interface BehaviorBaseline {
  /** runs per day (mean). */
  runsPerDay: number
  /** total tokens per run (mean). */
  tokensPerRun: number
  /** error rate (0..1). */
  errorRate: number
  /** models seen. */
  models: string[]
  totalRuns: number
  windowDays: number
}

export interface BehaviorDeviation {
  kind: 'run-spike' | 'token-blowout' | 'error-spike' | 'unusual-model'
  message: string
  value: number | string
  baseline: number | string
  at: number
}

export interface BehaviorOptions {
  /** spike threshold: current runs/day > runsPerDay * this (default 3). */
  runSpikeFactor?: number
  /** token blowout: a run's tokens > tokensPerRun * this (default 5). */
  tokenBlowoutFactor?: number
  /** error spike: current error rate > baseline + this (default 0.3 = 30 points). */
  errorSpikeDelta?: number
  now?: () => number
}

const DAY = 86_400_000

export class BehaviorLedger {
  private readonly events: RunEvent[] = []
  private readonly now: () => number

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? (() => Date.now())
  }

  /** Ingest a run event (from an AgentRunRecord). */
  ingest(event: RunEvent): void {
    this.events.push(event)
  }

  /** Ingest an AgentRunRecord. */
  ingestRecord(record: AgentRunRecord): void {
    this.ingest({
      at: record.startedAt,
      sessionId: record.sessionId,
      ...(record.model ? { model: record.model } : {}),
      status: record.status,
      promptTokens: record.promptTokens,
      completionTokens: record.completionTokens,
    })
  }

  /** Events within a window. */
  eventsIn(sinceMs: number): readonly RunEvent[] {
    return this.events.filter((e) => e.at >= sinceMs)
  }

  /** Compute the baseline over a window (default 14 days), EXCLUDING the current
   * day — so today's behavior is compared against prior behavior, not itself. */
  baseline(windowDays = 14): BehaviorBaseline {
    const now = this.now()
    const since = now - windowDays * DAY
    const dayStart = now - DAY
    const recent = this.events.filter((e) => e.at >= since && e.at < dayStart)
    const totalRuns = recent.length
    const errors = recent.filter((e) => /fail|error|aborted/i.test(e.status)).length
    const tokens = recent.map((e) => e.promptTokens + e.completionTokens)
    const models = Array.from(new Set(recent.map((e) => e.model).filter((m): m is string => Boolean(m))))
    return {
      runsPerDay: totalRuns / windowDays,
      tokensPerRun: tokens.length > 0 ? tokens.reduce((a, b) => a + b, 0) / tokens.length : 0,
      errorRate: totalRuns > 0 ? errors / totalRuns : 0,
      models,
      totalRuns,
      windowDays,
    }
  }

  /** Detect behavioral deviations in the most recent day vs. the baseline. */
  detect(opts: BehaviorOptions = {}): BehaviorDeviation[] {
    const now = this.now()
    const baseline = this.baseline(14)
    const today = this.events.filter((e) => e.at >= now - DAY)
    const deviations: BehaviorDeviation[] = []
    const runSpikeFactor = opts.runSpikeFactor ?? 3
    const tokenBlowoutFactor = opts.tokenBlowoutFactor ?? 5
    const errorSpikeDelta = opts.errorSpikeDelta ?? 0.3

    // run spike: today's runs/day far above baseline.
    const todayRunsPerDay = today.length
    if (baseline.runsPerDay > 0 && todayRunsPerDay > baseline.runsPerDay * runSpikeFactor) {
      deviations.push({
        kind: 'run-spike',
        message: `unusual activity: ${todayRunsPerDay} runs today vs baseline ${baseline.runsPerDay.toFixed(1)}/day`,
        value: todayRunsPerDay, baseline: baseline.runsPerDay, at: now,
      })
    }

    // token blowout: a single run far above the mean token usage.
    for (const e of today) {
      const total = e.promptTokens + e.completionTokens
      if (baseline.tokensPerRun > 0 && total > baseline.tokensPerRun * tokenBlowoutFactor) {
        deviations.push({
          kind: 'token-blowout',
          message: `token blowout in session ${e.sessionId}: ${total} tokens vs baseline ${baseline.tokensPerRun.toFixed(0)}`,
          value: total, baseline: baseline.tokensPerRun, at: e.at,
        })
        break // report the worst once
      }
    }

    // error spike: today's error rate far above baseline.
    if (today.length > 0) {
      const todayErrors = today.filter((e) => /fail|error|aborted/i.test(e.status)).length
      const todayErrorRate = todayErrors / today.length
      if (todayErrorRate > baseline.errorRate + errorSpikeDelta && today.length >= 2) {
        deviations.push({
          kind: 'error-spike',
          message: `error spike: ${(todayErrorRate * 100).toFixed(0)}% of runs failed today vs baseline ${(baseline.errorRate * 100).toFixed(0)}%`,
          value: todayErrorRate, baseline: baseline.errorRate, at: now,
        })
      }
    }

    // unusual model: a model used today that isn't in the baseline set.
    const todayModels = Array.from(new Set(today.map((e) => e.model).filter((m): m is string => Boolean(m))))
    for (const m of todayModels) {
      if (baseline.models.length > 0 && !baseline.models.includes(m)) {
        deviations.push({
          kind: 'unusual-model',
          message: `unusual model in use: ${m} (baseline: ${baseline.models.join(', ')})`,
          value: m, baseline: baseline.models.join(','), at: now,
        })
      }
    }

    return deviations
  }

  size(): number {
    return this.events.length
  }

  clear(): void {
    this.events.length = 0
  }
}
