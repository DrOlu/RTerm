/**
 * gatewayRateLimit — per-client token-bucket rate limiting for the gateway
 * (v3.2.18).
 *
 * Protects the WS/HTTP gateway from hammering: each client (identified by IP
 * or token id) gets a token bucket; requests that exceed the rate are
 * rejected with a 429-style error instead of consuming server capacity.
 * Failed authentication attempts are tracked separately with a lockout, so a
 * token brute-force can't run unbounded.
 *
 * Pure + injectable: the clock is injectable for tests.
 */

export interface RateLimitOptions {
  /** bucket capacity (burst size). Default 60. */
  capacity?: number
  /** tokens refilled per second. Default 1 (sustained 1 req/s, burst 60). */
  refillPerSecond?: number
  /** failed-auth attempts before lockout. Default 5. */
  authFailureLimit?: number
  /** lockout duration ms. Default 60_000. */
  authLockoutMs?: number
  /** clock, injectable for tests */
  now?: () => number
}

export interface RateLimitDecision {
  allowed: boolean
  /** remaining tokens after this request */
  remaining: number
  /** ms until the client may retry (when denied) */
  retryAfterMs?: number
  reason?: 'rate-limited' | 'locked-out'
}

interface Bucket {
  tokens: number
  lastRefill: number
}

interface AuthTracker {
  failures: number
  lockedUntil: number
}

export class GatewayRateLimiter {
  private readonly capacity: number
  private readonly refillPerSecond: number
  private readonly authFailureLimit: number
  private readonly authLockoutMs: number
  private readonly now: () => number
  private readonly buckets = new Map<string, Bucket>()
  private readonly authTrackers = new Map<string, AuthTracker>()

  constructor(opts: RateLimitOptions = {}) {
    this.capacity = opts.capacity ?? 60
    this.refillPerSecond = opts.refillPerSecond ?? 1
    this.authFailureLimit = opts.authFailureLimit ?? 5
    this.authLockoutMs = opts.authLockoutMs ?? 60_000
    this.now = opts.now ?? (() => Date.now())
  }

  private refill(bucket: Bucket): void {
    const t = this.now()
    const elapsed = (t - bucket.lastRefill) / 1000
    if (elapsed <= 0) return
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillPerSecond)
    bucket.lastRefill = t
  }

  /** Check (and consume) one token for a client. */
  check(clientKey: string): RateLimitDecision {
    const t = this.now()
    const bucket = this.buckets.get(clientKey) ?? { tokens: this.capacity, lastRefill: t }
    this.refill(bucket)
    this.buckets.set(clientKey, bucket)

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1
      return { allowed: true, remaining: Math.floor(bucket.tokens) }
    }
    // Time until one token refills.
    const msToNextToken = Math.ceil((1 - bucket.tokens) / this.refillPerSecond * 1000)
    return { allowed: false, remaining: 0, retryAfterMs: msToNextToken, reason: 'rate-limited' }
  }

  /** Record a failed authentication attempt; returns the lockout decision. */
  recordAuthFailure(clientKey: string): RateLimitDecision {
    const t = this.now()
    const tracker = this.authTrackers.get(clientKey) ?? { failures: 0, lockedUntil: 0 }
    tracker.failures += 1
    if (tracker.failures >= this.authFailureLimit) {
      tracker.lockedUntil = t + this.authLockoutMs
      tracker.failures = 0 // reset the counter; the lockout is now active
    }
    this.authTrackers.set(clientKey, tracker)
    if (t < tracker.lockedUntil) {
      return { allowed: false, remaining: 0, retryAfterMs: tracker.lockedUntil - t, reason: 'locked-out' }
    }
    return { allowed: true, remaining: this.authFailureLimit - tracker.failures }
  }

  /** Clear auth failures on successful authentication. */
  recordAuthSuccess(clientKey: string): void {
    this.authTrackers.delete(clientKey)
  }

  /** Is this client currently locked out? */
  isLockedOut(clientKey: string): boolean {
    const tracker = this.authTrackers.get(clientKey)
    if (!tracker) return false
    return this.now() < tracker.lockedUntil
  }

  /** Drop state for a client (on disconnect). */
  forget(clientKey: string): void {
    this.buckets.delete(clientKey)
    this.authTrackers.delete(clientKey)
  }

  /** Number of tracked clients (for monitoring/tests). */
  get clientCount(): number {
    return this.buckets.size
  }
}
