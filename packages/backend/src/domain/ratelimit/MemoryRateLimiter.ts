import { windowStartOf } from '@backend/domain/ratelimit/ports';
import { resultOf } from '@backend/domain/ratelimit/result';

import type { RateLimiter, RateLimitResult, RateLimitRule } from '@backend/domain/ratelimit/ports';

/** In-process counters, for tests. */
export class MemoryRateLimiter implements RateLimiter {
  private readonly counts = new Map<string, number>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async consume(bucket: string, rule: RateLimitRule, cost = 1): Promise<RateLimitResult> {
    const windowStart = windowStartOf(this.now(), rule.windowSeconds);
    const key = `${bucket}@${windowStart.toISOString()}`;
    const count = (this.counts.get(key) ?? 0) + cost;
    this.counts.set(key, count);
    return await Promise.resolve(resultOf(count, rule, windowStart));
  }
}
