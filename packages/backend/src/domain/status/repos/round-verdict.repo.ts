import { and, asc, eq } from 'drizzle-orm';

import { DayPartitions } from '@backend/infra/db/day-partitions';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

export type RoundVerdictRow = typeof schema.statusRoundVerdicts.$inferSelect;

const v = schema.statusRoundVerdicts;

/** Data access for mocco_status_round_verdicts, partitioned by day like the raw results. */
export class RoundVerdictRepo {
  readonly partitions: DayPartitions;

  constructor(private readonly db: Db) {
    this.partitions = new DayPartitions(db, 'mocco_status_round_verdicts');
  }

  /** Record a closed round; a round closed already keeps its first verdict. The day's partition
   * must exist (the evaluator ensures it before its transactions). */
  async insert(row: typeof v.$inferInsert): Promise<boolean> {
    const inserted = await this.db.insert(v).values(row).onConflictDoNothing().returning({ roundAt: v.roundAt });
    return inserted.length > 0;
  }

  async listForMonitor(workspaceId: string, monitorId: string): Promise<RoundVerdictRow[]> {
    return await this.db
      .select()
      .from(v)
      .where(and(eq(v.workspaceId, workspaceId), eq(v.monitorId, monitorId)))
      .orderBy(asc(v.roundAt))
      .limit(500);
  }
}
