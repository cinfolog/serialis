/**
 * Per-key token bucket of the public API (spec 14.1): 20 requests per second, burst of 100,
 * counted inside the shop's object (one instance per object, single-threaded, so no race). The
 * state lives in memory: an evicted object starts again with a full bucket, which only ever
 * grants the burst once more (workers/DECISIONS.md).
 */
export const RATE_PER_SECOND = 20;
export const BURST = 100;

export interface RateDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the bucket is full again. */
  resetSeconds: number;
  /** Seconds before the next request can pass (0 when allowed). */
  retryAfterSeconds: number;
}

interface Bucket {
  tokens: number;
  at: number;
}

export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly ratePerSecond = RATE_PER_SECOND,
    private readonly burst = BURST,
  ) {}

  take(key: string, now: number): RateDecision {
    const previous = this.buckets.get(key) ?? { tokens: this.burst, at: now };
    const elapsed = Math.max(0, now - previous.at) / 1000;
    let tokens = Math.min(this.burst, previous.tokens + elapsed * this.ratePerSecond);
    const allowed = tokens >= 1;
    if (allowed) tokens -= 1;
    this.buckets.set(key, { tokens, at: now });
    if (this.buckets.size > 1_000) this.prune(now);
    return {
      allowed,
      limit: this.burst,
      remaining: Math.floor(tokens),
      resetSeconds: Math.ceil((this.burst - tokens) / this.ratePerSecond),
      retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((1 - tokens) / this.ratePerSecond)),
    };
  }

  /** Buckets full again carry no information. */
  private prune(now: number): void {
    for (const [key, b] of this.buckets) {
      if (b.tokens + ((now - b.at) / 1000) * this.ratePerSecond >= this.burst) this.buckets.delete(key);
    }
  }
}

/** `RateLimit-*` headers (IETF draft "RateLimit header fields for HTTP"), plus the policy. */
export function rateLimitHeaders(d: RateDecision): Record<string, string> {
  return {
    'RateLimit-Limit': String(d.limit),
    'RateLimit-Remaining': String(d.remaining),
    'RateLimit-Reset': String(d.resetSeconds),
    'RateLimit-Policy': `${BURST};w=${BURST / RATE_PER_SECOND};burst=${BURST};rate=${RATE_PER_SECOND}`,
  };
}
