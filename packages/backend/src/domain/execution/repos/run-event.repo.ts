import { and, asc, eq, gt } from 'drizzle-orm';

import { expectOne } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

/** Data access for mocco_run_events — the append-only progression log that drives
 * the live timeline. Reads are scoped by `workspace_id` (carried on each row). */
export class RunEventRepo {
  constructor(private readonly db: Db) {}

  /** Append one event and return the created row (with its assigned `seq`). */
  async append(row: typeof schema.runEvents.$inferInsert) {
    return expectOne(await this.db.insert(schema.runEvents).values(row).returning());
  }

  /** Events for a run with `seq > sinceSeq`, oldest-first — the `sinceSeq` live poll. */
  async listSince(workspaceId: string, runId: string, sinceSeq: bigint) {
    return await this.db
      .select()
      .from(schema.runEvents)
      .where(
        and(
          eq(schema.runEvents.workspaceId, workspaceId),
          eq(schema.runEvents.runId, runId),
          gt(schema.runEvents.seq, sinceSeq),
        ),
      )
      .orderBy(asc(schema.runEvents.seq));
  }
}
