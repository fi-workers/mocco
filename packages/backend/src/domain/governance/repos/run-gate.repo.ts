import { and, asc, eq } from 'drizzle-orm';

import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';
import type { GateState } from '@mocco/common/governance';

/** Data access for mocco_run_gates — the gates materialized from a run's pinned v2
 * pipeline definition. Reads are scoped by `workspace_id` (carried on each row). */
export class RunGateRepo {
  constructor(private readonly db: Db) {}

  /** Materialize a run's gates in one write. Returns the inserted rows in insertion order. */
  async insertMany(rows: (typeof schema.runGates.$inferInsert)[]) {
    if (rows.length === 0) {
      return [];
    }
    return await this.db.insert(schema.runGates).values(rows).returning();
  }

  /** A run's gates in item order, scoped to the workspace. */
  async findByRun(workspaceId: string, runId: string) {
    return await this.db
      .select()
      .from(schema.runGates)
      .where(and(eq(schema.runGates.workspaceId, workspaceId), eq(schema.runGates.runId, runId)))
      .orderBy(asc(schema.runGates.itemIndex));
  }

  /** The gate at a given item index within a run, or undefined — the advance loop
   * checks whether the item the cursor points at is a gate (a pause) or a step. */
  async findByRunAndIndex(runId: string, itemIndex: number) {
    const [row] = await this.db
      .select()
      .from(schema.runGates)
      .where(and(eq(schema.runGates.runId, runId), eq(schema.runGates.itemIndex, itemIndex)));
    return row;
  }

  /** Settle a gate's state (and its resolved-at). Scoped by workspace_id. */
  async updateState(workspaceId: string, gateId: string, patch: { state: GateState; resolvedAt?: Date | null }) {
    await this.db
      .update(schema.runGates)
      .set(patch)
      .where(and(eq(schema.runGates.id, gateId), eq(schema.runGates.workspaceId, workspaceId)));
  }
}
