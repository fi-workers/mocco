import { lt, sql } from 'drizzle-orm';

import { expectOne } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

/** Data access for mocco_rate_limit_counters. */
export class RateLimitCounterRepo {
  constructor(private readonly db: Db) {}

  /** Add `cost` to the bucket's counter for the window and return the new count, in one
   * statement, so concurrent requests can't both see a count under the limit. */
  async increment(bucket: string, windowStart: Date, cost: number): Promise<number> {
    const row = expectOne(
      await this.db
        .insert(schema.rateLimitCounters)
        .values({ bucket, windowStart, count: cost })
        .onConflictDoUpdate({
          target: [schema.rateLimitCounters.bucket, schema.rateLimitCounters.windowStart],
          set: { count: sql`${schema.rateLimitCounters.count} + ${cost}` },
        })
        .returning({ count: schema.rateLimitCounters.count }),
    );
    return row.count;
  }

  /** Drop counters of windows that started before `before`. */
  async prune(before: Date): Promise<void> {
    await this.db.delete(schema.rateLimitCounters).where(lt(schema.rateLimitCounters.windowStart, before));
  }
}
