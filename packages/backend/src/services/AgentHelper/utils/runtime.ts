export function isAbortError(error: unknown): boolean {
  if (!error) return false
  if (error instanceof Error) {
    return error.name === 'AbortError' || error.message === 'AbortError'
  }
  return false
}

export async function invokeWithRetry<T>(
  fn: (attempt: number) => Promise<T>,
  maxRetries: number = 4,
  delays: number[] = [1000, 2000, 4000, 6000],
  signal?: AbortSignal
): Promise<T> {
  let lastError: any
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (signal?.aborted) {
      throw new Error('AbortError')
    }
    try {
      return await fn(attempt)
    } catch (error: any) {
      lastError = error
      if (isAbortError(error)) {
        throw error
      }

      // v3.8.4: fail fast on DETERMINISTIC errors. Previously every non-abort
      // error was retried, so a truncated response ("finish_reason=length")
      // or a code bug ("reading 'map'") burned 4 attempts + 13s of backoff
      // and then failed anyway. The classifier decides; a transient error
      // (socket reset, 429, 503) still retries exactly as before.
      if (!isRetryableError(error)) {
        throw error
      }

      if (attempt < maxRetries - 1) {
        const delay = delays[attempt]
        console.warn(`[AgentService] Model invocation failed (Attempt ${attempt + 1}/${maxRetries}). Error: ${error.message}. Retrying in ${delay}ms...`)
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, delay)
          const onAbort = () => {
            clearTimeout(timer)
            reject(new Error('AbortError'))
          }
          if (signal?.aborted) onAbort()
          signal?.addEventListener('abort', onAbort, { once: true })
        })
        continue
      }
    }
  }
  throw lastError
}

/**
 * Decide whether an error is worth retrying.
 *
 * ROOT CAUSE (v3.8.4): this used to be `!isAbortError(error)` — i.e. retry
 * EVERYTHING except an abort. That made deterministic failures retry forever:
 *
 *  - "empty unusable response (finish_reason=length)" is a TRUNCATED answer.
 *    The same prompt with the same max_tokens produces it again, so all 4
 *    attempts failed identically and the user saw "Retrying (3/4)…" before a
 *    guaranteed failure. Retrying was pure latency.
 *  - "empty unusable response (finish_reason=error)" is PROVIDER-SIDE and
 *    often transient, so it deliberately still retries — the two cases share
 *    one message and are separated on the finish reason, not the wording.
 *  - "Cannot read properties of undefined (reading 'map')" is a code/protocol
 *    bug. Re-sending identical input cannot fix it.
 *
 * Only TRANSIENT failures are retried now: network/socket errors, timeouts,
 * rate limits (429), and 5xx. Deterministic errors (4xx other than 429,
 * truncation, malformed payloads) fail fast with the real reason.
 */
function errorText(error: any): string {
  const parts: string[] = [];
  if (typeof error?.message === "string") parts.push(error.message);
  if (typeof error?.error?.message === "string") parts.push(error.error.message);
  if (typeof error?.code === "string") parts.push(error.code);
  if (typeof error?.status === "number") parts.push(String(error.status));
  if (typeof error?.statusCode === "number") parts.push(String(error.statusCode));
  if (typeof error?.cause?.code === "string") parts.push(error.cause.code);
  return parts.join(" ").toLowerCase();
}

export function isRetryableError(error: unknown): boolean {
  if (isAbortError(error)) return false;

  const text = errorText(error);
  if (!text) return false;

  // Error NAMES that are deterministic outcomes of the model/stream, not
  // transport problems. Checked first so a stack frame containing "timeout"
  // cannot misclassify them.
  // An empty response carries its finish reason in the message:
  //   "Model stream ended with an empty unusable response (finish_reason=X)."
  // Split on it BEFORE the generic lists — "error" is provider-side and worth
  // retrying, while "length"/"content_filter" repeat on the same input.
  const finishMatch = text.match(/finish_reason=([^.)]*)/)
  if (finishMatch) {
    const reasons = finishMatch[1].split(/[,\s]+/).filter(Boolean)
    // Provider-side error finish: an empty "error" finish is a known transient
    // hiccup that recovers on the next attempt (see the spec case "empty
    // provider error stream retries instead of ending the turn silently").
    if (reasons.includes("error")) return true
    // Truncation / policy block: the identical request repeats the outcome,
    // so retrying is pure latency.
    const deterministicReasons = new Set(["length", "content_filter"])
    if (reasons.length > 0 && reasons.every((r) => deterministicReasons.has(r))) {
      return false
    }
    // Unknown/absent reason -> fall through to the generic heuristics below.
  }

  const deterministic = [
    "empty unusable response",
    "cannot read properties of undefined",
    "cannot read properties of null",
    "is not a function",
    "bad request",
    "invalid_request",
    "validation",
    "context_length",
    "context length",
    "maximum context",
    "too many tokens",
    "unsupported",
    "malformed",
    "unauthorized",
    "forbidden",
    "model_not_found",
    "insufficient_quota",
    "invalid api key",
    "invalid_api_key",
  ];
  if (deterministic.some((needle) => text.includes(needle))) return false;

  // Transient network / transport failures.
  const transient = [
    "econnreset",
    "econnrefused",
    "etimedout",
    "esockettimedout",
    "epipe",
    "enotfound",
    "eai_again",
    "socket hang up",
    "network",
    "fetch failed",
    "connection reset",
    "connection error",
    "premature close",
    "timed out",
    "timeout",
    "terminated",
    "502",
    "503",
    "504",
    "429",
    "rate limit",
    "overloaded",
    "server error",
    "bad gateway",
    "service unavailable",
    "gateway timeout",
  ];
  return transient.some((needle) => text.includes(needle));
}

export function extractErrorDetails(error: any): string {
  let details = ''

  if (error.error?.metadata?.raw) {
    try {
      const raw = typeof error.error.metadata.raw === 'string'
        ? JSON.parse(error.error.metadata.raw)
        : error.error.metadata.raw
      details += `Provider Error:\n${JSON.stringify(raw, null, 2)}\n\n`
    } catch {
      details += `Provider Error (Raw):\n${error.error.metadata.raw}\n\n`
    }
  } else if (error.error?.message) {
    details += `Provider Message: ${error.error.message}\n\n`
  }

  if (error.status) details += `Status: ${error.status}\n`
  details += `Stack Trace:\n${error.stack || error.toString()}`
  return details
}
