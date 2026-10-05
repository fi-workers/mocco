import { and, gte, lt, max, sql } from 'drizzle-orm';

import { inBatches } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

export type RollupHourlyRow = typeof schema.statusRollupsHourly.$inferSelect;

const h = schema.statusRollupsHourly;
/** Rows per statement: well under Postgres's bind-parameter limit at this table's width. */
const UPSERT_BATCH = 1000;

/** Data access for mocco_status_rollups_hourly. The rollup job writes every workspace's rows. */
export class RollupHourlyRepo {
  constructor(private readonly db: Db) {}

  /** Write the hours, replacing rows already there: rolling an hour up again is idempotent. */
  async upsertMany(rows: readonly (typeof h.$inferInsert)[]): Promise<void> {
    await inBatches(
      rows,
      UPSERT_BATCH,
      async batch =>
        await this.db
          .insert(h)
          .values(batch)
          .onConflictDoUpdate({
            target: [h.monitorId, h.hour],
            set: {
              rounds: sql`excluded.rounds`,
              okRounds: sql`excluded.ok_rounds`,
              failRounds: sql`excluded.fail_rounds`,
              unknownRounds: sql`excluded.unknown_rounds`,
              downSeconds: sql`excluded.down_seconds`,
              latencySumMs: sql`excluded.latency_sum_ms`,
              latencyCount: sql`excluded.latency_count`,
              latencyHist: sql`excluded.latency_hist`,
            },
          }),
    );
  }

  /** Every monitor's hours in `[from, to)`. */
  async listBetween(from: Date, to: Date): Promise<RollupHourlyRow[]> {
    return await this.db
      .select()
      .from(h)
      .where(and(gte(h.hour, from), lt(h.hour, to)));
  }

  /** The latest hour any monitor has a row for, or null. */
  async latestHour(): Promise<Date | null> {
    const [row] = await this.db.select({ hour: max(h.hour) }).from(h);
    return row?.hour ?? null;
  }

  /** Delete the hours before `before` (retention); the number deleted. */
  async deleteBefore(before: Date): Promise<number> {
    const deleted = await this.db.delete(h).where(lt(h.hour, before)).returning({ monitorId: h.monitorId });
    return deleted.length;
  }
}
