import { and, asc, eq, gte, sql } from 'drizzle-orm';

import { inBatches } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

export type RollupDailyRow = typeof schema.statusRollupsDaily.$inferSelect;

const d = schema.statusRollupsDaily;
/** Rows per statement: well under Postgres's bind-parameter limit at this table's width. */
const UPSERT_BATCH = 1000;

/** Data access for mocco_status_rollups_daily, kept forever. The rollup job writes every
 * workspace's rows. */
export class RollupDailyRepo {
  constructor(private readonly db: Db) {}

  /** Write the days, replacing rows already there: rolling a day up again is idempotent. */
  async upsertMany(rows: readonly (typeof d.$inferInsert)[]): Promise<void> {
    await inBatches(
      rows,
      UPSERT_BATCH,
      async batch =>
        await this.db
          .insert(d)
          .values(batch)
          .onConflictDoUpdate({
            target: [d.monitorId, d.day],
            set: {
              rounds: sql`excluded.rounds`,
              okRounds: sql`excluded.ok_rounds`,
              downSeconds: sql`excluded.down_seconds`,
              maintenanceSeconds: sql`excluded.maintenance_seconds`,
              uptimeRatio: sql`excluded.uptime_ratio`,
              latencyHist: sql`excluded.latency_hist`,
              p95Ms: sql`excluded.p95_ms`,
            },
          }),
    );
  }

  /** One monitor's days from `fromDay` (`YYYY-MM-DD`) on, oldest first. */
  async listForMonitor(workspaceId: string, monitorId: string, fromDay: string): Promise<RollupDailyRow[]> {
    return await this.db
      .select()
      .from(d)
      .where(and(eq(d.workspaceId, workspaceId), eq(d.monitorId, monitorId), gte(d.day, fromDay)))
      .orderBy(asc(d.day));
  }
}
