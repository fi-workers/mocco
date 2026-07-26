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

  /** The step at a given index within a run, or undefined — the callback resolves
   * the step it targets (and whether one beyond it exists, to decide advance vs finish). */
  async findByRunAndIndex(runId: string, stepIndex: number) {
    const [row] = await this.db
      .select()
      .from(schema.runSteps)
      .where(and(eq(schema.runSteps.runId, runId), eq(schema.runSteps.stepIndex, stepIndex)));
    return row;
  }

  /** Patch mutable step fields (status/handle/logs). Scoped by workspace_id. */
  async update(
    workspaceId: string,
    stepId: string,
    patch: Partial<Pick<typeof schema.runSteps.$inferInsert, 'status' | 'handle' | 'logsUrl'>>,
  ) {
    await this.db
      .update(schema.runSteps)
      .set(patch)
      .where(and(eq(schema.runSteps.id, stepId), eq(schema.runSteps.workspaceId, workspaceId)));
  }
}
