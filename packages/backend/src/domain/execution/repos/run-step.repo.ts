import { and, asc, eq } from 'drizzle-orm';

import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

/** Data access for mocco_run_steps — the steps materialized from a run's pinned
 * config definition. Reads are scoped by `workspace_id` (carried on each row). */
export class RunStepRepo {
  constructor(private readonly db: Db) {}

  /** Materialize a run's steps in one write. Returns the inserted rows in insertion order. */
  async insertMany(rows: (typeof schema.runSteps.$inferInsert)[]) {
    if (rows.length === 0) {
      return [];
    }
    return await this.db.insert(schema.runSteps).values(rows).returning();
  }

  /** A run's steps in definition order, scoped to the workspace. */
  async listByRun(workspaceId: string, runId: string) {
    return await this.db
      .select()
      .from(schema.runSteps)
      .where(and(eq(schema.runSteps.workspaceId, workspaceId), eq(schema.runSteps.runId, runId)))
      .orderBy(asc(schema.runSteps.stepIndex));
  }
}
