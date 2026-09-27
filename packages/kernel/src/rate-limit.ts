/**
 * Per-key token buckets (threat model A-5, T-05, T-13, L-09).
 *
 * Pure and dependency-free: no I/O, and time comes from the `now` function,
 * so the host, the web app and tests share one implementation. Buckets live
 * in memory: they reset when the process restarts, and each process (each
 * serverless instance of the web app) keeps its own. That bounds a single
 * caller per instance; it is not a global quota.
 */

export interface RateLimitConfig {
  /** Requests a key may make at once (bucket size). */
  burst: number
  /** Sustained requests per minute (refill rate). */
  perMinute: number
}

export type RateLimitResult = { ok: true } | { ok: false; retryAfterSeconds: number }

/** Largest number of keys a limiter tracks; the oldest key is dropped beyond it. */
export const MAX_RATE_LIMIT_KEYS = 10_000

/** Throws when a config cannot work (burst below 1, or a rate that is not positive). */
export function assertRateLimitConfig(config: RateLimitConfig, label = 'Rate limit'): void {
  if (!(Number.isFinite(config.burst) && config.burst >= 1) || !(Number.isFinite(config.perMinute) && config.perMinute > 0)) {
    throw new Error(`${label}: burst must be at least 1 and perMinute above 0.`)
  }
}

/** A simple token bucket per key (a principal id, a webhook endpoint id). */
export class TokenBucketLimiter {
  readonly config: RateLimitConfig
  private readonly buckets = new Map<string, { tokens: number; at: number }>()
  private readonly now: () => number

  constructor(config: RateLimitConfig, now: () => number = Date.now) {
    assertRateLimitConfig(config)
    this.config = { burst: config.burst, perMinute: config.perMinute }
    this.now = now
  }

  /** Take one token for `key`; when none is left, say how many whole seconds until one is. */
  take(key: string): RateLimitResult {
    const now = this.now()
    const rate = this.config.perMinute / 60_000
    const b = this.buckets.get(key) ?? { tokens: this.config.burst, at: now }
    b.tokens = Math.min(this.config.burst, b.tokens + Math.max(0, now - b.at) * rate)
    b.at = now
    if (this.buckets.size >= MAX_RATE_LIMIT_KEYS && !this.buckets.has(key)) this.buckets.delete(this.buckets.keys().next().value!)
    this.buckets.set(key, b)
    if (b.tokens >= 1) {
      b.tokens -= 1
      return { ok: true }
    }
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((1 - b.tokens) / rate / 1000)) }
  }
}

/**
 * Parse a `burst/perMinute` setting such as `5/10` (an environment variable).
 * Returns the fallback for an empty value and null for a malformed one, so the
 * caller decides whether to warn or refuse.
 */
export function parseRateLimitSetting(value: string | undefined, fallback: RateLimitConfig): RateLimitConfig | null {
  const text = (value ?? '').trim()
  if (!text) return { ...fallback }
  const match = /^(\d{1,4})\s*\/\s*(\d{1,5}(?:\.\d+)?)$/.exec(text)
  if (!match) return null
  const config = { burst: Number(match[1]), perMinute: Number(match[2]) }
  if (config.burst < 1 || config.burst > 1_000 || !(config.perMinute > 0) || config.perMinute > 6_000) return null
  return config
}
