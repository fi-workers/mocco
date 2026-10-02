import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PostgresRateLimiter } from '@backend/domain/ratelimit/PostgresRateLimiter';
import { RateLimitCounterRepo } from '@backend/domain/ratelimit/repos/rate-limit-counter.repo';
import { rateLimitCounters } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

describe('PostgresRateLimiter (pglite)', () => {
  let t: TestDb;
  let now: Date;
  let limiter: PostgresRateLimiter;
  const rule = { limit: 3, windowSeconds: 60 };

  beforeEach(async () => {
    t = await createTestDb();
    now = new Date('2026-10-01T10:00:10Z');
    limiter = new PostgresRateLimiter(new RateLimitCounterRepo(t.db), () => now);
  });
  afterEach(async () => {
    await t.close();
  });

  it('allows up to the limit per window, then refuses until the window resets', async () => {
    const results = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop -- consumes must be sequential to count in order
      results.push(await limiter.consume('key:a', rule));
    }

    expect(results.map(result => [result.allowed, result.remaining])).toEqual([
      [true, 2],
      [true, 1],
      [true, 0],
      [false, 0],
    ]);
    expect(results[3]?.resetAt.toISOString()).toBe('2026-10-01T10:01:00.000Z');

    now = new Date('2026-10-01T10:01:00Z');
    expect(await limiter.consume('key:a', rule)).toMatchObject({ allowed: true, remaining: 2 });
    expect(await limiter.consume('key:b', rule)).toMatchObject({ allowed: true, remaining: 2 });
  });

  it('counts concurrent requests atomically', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, async () => await limiter.consume('key:c', rule)));
    expect(results.filter(result => result.allowed)).toHaveLength(3);
  });

  it('prunes old windows', async () => {
    await limiter.consume('key:d', rule);
    await new RateLimitCounterRepo(t.db).prune(new Date('2026-10-01T11:00:00Z'));
    expect(await t.db.select().from(rateLimitCounters)).toHaveLength(0);
  });
});
