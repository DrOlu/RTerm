/**
 * modelFailover — transparent provider/model failover for the agent loop
 * (v3.2.18).
 *
 * When the active model's provider errors (network down, 429 rate limit, 5xx,
 * auth failure), the agent retries the SAME request against a configured
 * fallback chain instead of failing the run. Pure + injectable: the decision
 * logic is testable without any network.
 *
 * Usage in the model-request node:
 *   const chain = buildFailoverChain(primary, fallbacks)
 *   for (const candidate of chain) {
 *     try { return await invoke(candidate) }
 *     catch (e) { if (!isFailoverEligible(e)) throw e; lastError = e }
 *   }
 *   throw lastError
 */

export interface FailoverModel {
  /** model id, e.g. "moonshotai/kimi-k3" */
  model: string
  /** optional label for logging */
  label?: string
}

/** Errors that justify trying another provider. */
const FAILOVER_ERROR_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\b429\b|rate.?limit|too many requests|quota/i, reason: 'rate-limited' },
  { re: /\b5\d\d\b|internal server error|bad gateway|service unavailable|upstream/i, reason: 'provider-5xx' },
  { re: /network|fetch failed|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up/i, reason: 'network' },
  { re: /\b401\b|unauthorized|invalid api key|authentication/i, reason: 'auth' },
  { re: /overloaded|capacity|model .* not found|no such model/i, reason: 'model-unavailable' },
]

/** Errors that should NOT trigger failover (the request itself is bad). */
const NON_FAILOVER_PATTERNS: RegExp[] = [
  /context.?length|token limit|maximum context/i,
  /invalid request|malformed|bad request|\b400\b/i,
  /aborted|AbortError/i, // user cancelled — never retry
]

/**
 * Decide whether an error is worth failing over for.
 * Order matters: non-failover patterns win (a bad request will fail on every
 * provider, and an abort must never be retried).
 */
export function isFailoverEligible(error: unknown): { eligible: boolean; reason?: string } {
  const message = error instanceof Error ? error.message : String(error ?? '')

  for (const re of NON_FAILOVER_PATTERNS) {
    if (re.test(message)) return { eligible: false, reason: 'non-failover-error' }
  }
  for (const { re: pattern, reason } of FAILOVER_ERROR_PATTERNS) {
    if (pattern.test(message)) return { eligible: true, reason }
  }
  // Unknown errors: fail over conservatively — a wrong-but-successful answer
  // beats a hard failure, and the chain is bounded anyway.
  return { eligible: true, reason: 'unknown-error' }
}

/** Build the failover chain: primary first, then fallbacks (deduped). */
export function buildFailoverChain(
  primary: FailoverModel,
  fallbacks: readonly FailoverModel[] | undefined,
): FailoverModel[] {
  const chain: FailoverModel[] = [primary]
  if (!Array.isArray(fallbacks)) return chain
  const seen = new Set([primary.model])
  for (const f of fallbacks) {
    if (!f || !f.model) continue
    if (seen.has(f.model)) continue
    seen.add(f.model)
    chain.push(f)
  }
  return chain
}

export interface FailoverAttempt {
  model: string
  ok: boolean
  reason?: string
  durationMs: number
}

export interface FailoverOutcome<T> {
  value?: T
  error?: unknown
  attempts: FailoverAttempt[]
  /** the model that produced the value, when successful */
  usedModel?: string
}

/**
 * Run an operation against the failover chain. Each candidate is tried once;
 * ineligible errors rethrow immediately; after the chain is exhausted the
 * last error is rethrown.
 */
export async function withModelFailover<T>(
  chain: readonly FailoverModel[],
  operation: (model: FailoverModel) => Promise<T>,
  opts: { onAttempt?: (a: FailoverAttempt) => void } = {},
): Promise<FailoverOutcome<T>> {
  const attempts: FailoverAttempt[] = []
  let lastError: unknown

  // v3.3.0: an empty chain is a caller bug — return an explicit error rather
  // than a silent "success" with no value (which looked like a real result).
  if (chain.length === 0) {
    return {
      error: new Error('model failover chain is empty — no candidates to try'),
      attempts,
    }
  }

  for (const candidate of chain) {
    const started = Date.now()
    try {
      const value = await operation(candidate)
      const attempt: FailoverAttempt = { model: candidate.model, ok: true, durationMs: Date.now() - started }
      attempts.push(attempt)
      opts.onAttempt?.(attempt)
      return { value, attempts, usedModel: candidate.model }
    } catch (error) {
      const decision = isFailoverEligible(error)
      const attempt: FailoverAttempt = {
        model: candidate.model,
        ok: false,
        reason: decision.reason,
        durationMs: Date.now() - started,
      }
      attempts.push(attempt)
      opts.onAttempt?.(attempt)
      if (!decision.eligible) {
        return { error, attempts }
      }
      lastError = error
    }
  }

  return { error: lastError, attempts }
}
