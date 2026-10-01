import { windowStartOf } from '@backend/domain/ratelimit/ports';
import { resultOf } from '@backend/domain/ratelimit/result';

import type { RateLimiter, RateLimitResult, RateLimitRule } from '@backend/domain/ratelimit/ports';
import type { RateLimitCounterRepo } from '@backend/domain/ratelimit/repos/rate-limit-counter.repo';

/** Fixed-window counters in Postgres: one upsert per request. */
export class PostgresRateLimiter implements RateLimiter {
  constructor(
    private readonly counters: RateLimitCounterRepo,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async consume(bucket: string, rule: RateLimitRule, cost = 1): Promise<RateLimitResult> {
    const windowStart = windowStartOf(this.now(), rule.windowSeconds);
    const count = await this.counters.increment(bucket, windowStart, cost);
    return resultOf(count, rule, windowStart);
  }
}
