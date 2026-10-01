import { and, desc, eq } from 'drizzle-orm';

import { expectOne } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

export type FlagChangesetRow = typeof schema.flagChangesets.$inferSelect;

/** Data access for mocco_flag_changesets. Every query is scoped by `workspace_id`. */
export class FlagChangesetRepo {
  constructor(private readonly db: Db) {}

  async insert(row: typeof schema.flagChangesets.$inferInsert) {
    return expectOne(await this.db.insert(schema.flagChangesets).values(row).returning());
  }

  /** The environment's changesets, newest first. */
  async listByEnvironment(workspaceId: string, environmentId: string, limit: number) {
    return await this.db
      .select()
      .from(schema.flagChangesets)
      .where(
        and(eq(schema.flagChangesets.workspaceId, workspaceId), eq(schema.flagChangesets.environmentId, environmentId)),
      )
      .orderBy(desc(schema.flagChangesets.createdAt))
      .limit(limit);
  }
}
