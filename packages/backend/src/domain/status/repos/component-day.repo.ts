import { sql } from 'drizzle-orm';

import { inBatches } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

export type ComponentDayRow = typeof schema.statusComponentDays.$inferSelect;

const cd = schema.statusComponentDays;
/** Rows per statement: well under Postgres's bind-parameter limit at this table's width. */
const UPSERT_BATCH = 1000;

/** Data access for mocco_status_component_days, the public page's 90-day bars. The rollup job
 * writes every workspace's rows. */
export class ComponentDayRepo {
  constructor(private readonly db: Db) {}

  /** Write the days, replacing rows already there: rolling a day up again is idempotent. */
  async upsertMany(rows: readonly (typeof cd.$inferInsert)[]): Promise<void> {
    await inBatches(
      rows,
      UPSERT_BATCH,
      async batch =>
        await this.db
          .insert(cd)
          .values(batch)
          .onConflictDoUpdate({
            target: [cd.componentId, cd.day],
            set: {
              worstStatus: sql`excluded.worst_status`,
              downSeconds: sql`excluded.down_seconds`,
              uptimeRatio: sql`excluded.uptime_ratio`,
              incidentIds: sql`excluded.incident_ids`,
            },
          }),
    );
  }
}
