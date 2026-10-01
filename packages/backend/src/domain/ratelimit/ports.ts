/** One rate-limit rule: at most `limit` units per fixed window of `windowSeconds`. */
export interface RateLimitRule {
  limit: number;
  windowSeconds: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Units left in the current window (0 once it's used up). */
  remaining: number;
  /** When the current window ends. */
  resetAt: Date;
}

/** The rate limiter port (ADR 0017). `postgres` is the default driver; `memory` is for
 * tests. A Redis driver can be added for high-volume hosted traffic. */
export interface RateLimiter {
  consume(bucket: string, rule: RateLimitRule, cost?: number): Promise<RateLimitResult>;
}

/** The start of the fixed window containing `now`. */
export function windowStartOf(now: Date, windowSeconds: number): Date {
  const windowMs = windowSeconds * 1000;
  return new Date(Math.floor(now.getTime() / windowMs) * windowMs);
}
