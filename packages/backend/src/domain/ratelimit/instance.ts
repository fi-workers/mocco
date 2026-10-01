// Production composition root for the rate limiter: the Postgres driver everywhere.
import { PostgresRateLimiter } from '@backend/domain/ratelimit/PostgresRateLimiter';
import { RateLimitCounterRepo } from '@backend/domain/ratelimit/repos/rate-limit-counter.repo';
import { getDb } from '@backend/infra/db/client';

import type { RateLimiter } from '@backend/domain/ratelimit/ports';

const state: { limiter?: RateLimiter } = {};

export function getRateLimiter(): RateLimiter {
  state.limiter ??= new PostgresRateLimiter(new RateLimitCounterRepo(getDb()));
  return state.limiter;
}
