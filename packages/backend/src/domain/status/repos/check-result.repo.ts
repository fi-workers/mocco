import { and, eq } from 'drizzle-orm';

import { DayPartitions, utcDayOf } from '@backend/infra/db/day-partitions';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

export type CheckResultRow = typeof schema.statusCheckResults.$inferSelect;

const r = schema.statusCheckResults;

/** Data access for mocco_status_check_results, the day-partitioned raw results. */
export class CheckResultRepo {
  readonly partitions: DayPartitions;

  constructor(private readonly db: Db) {
    this.partitions = new DayPartitions(db, 'mocco_status_check_results');
  }

  /**
   * Insert results, skipping any already stored for the same (monitor, round, location), and
   * return the lease ids actually inserted. A day without a partition yet (the job hasn't run
   * since the migration) gets one, and the insert is retried once.
   */
  async insertNew(rows: readonly (typeof r.$inferInsert)[]): Promise<string[]> {
    if (rows.length === 0) {
      return [];
    }
    return await this.partitions.withPartitions(
      rows.map(row => utcDayOf(row.roundAt)),
      async () => {
        const inserted = await this.db
          .insert(r)
          .values([...rows])
          .onConflictDoNothing()
          .returning({ leaseId: r.leaseId });
        return inserted.map(row => row.leaseId);
      },
    );
  }

  /** Every location's result for one round of a monitor. */
  async listForRound(workspaceId: string, monitorId: string, roundAt: Date): Promise<CheckResultRow[]> {
    return await this.db
      .select()
      .from(r)
      .where(and(eq(r.workspaceId, workspaceId), eq(r.monitorId, monitorId), eq(r.roundAt, roundAt)));
  }
}
