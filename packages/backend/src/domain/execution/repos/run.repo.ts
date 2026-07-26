import { and, desc, eq } from 'drizzle-orm';

import { expectOne, getOrThrow } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

/** Data access for mocco_runs. Every read/write is scoped by `workspace_id` —
 * runs carry it directly, so a run is never resolved by id alone. */
export class RunRepo {
  constructor(private readonly db: Db) {}

  /** Insert a run and return the created row (the service needs it to dispatch step 0). */
  async create(row: typeof schema.runs.$inferInsert) {
    return expectOne(await this.db.insert(schema.runs).values(row).returning());
  }

  /** A run owned by the workspace, keyed by its own id — or throw EntityNotFoundError
   * for a foreign or unknown id. Direct workspace_id scoping (runs carry it). */
  async getByIdInWorkspace(workspaceId: string, runId: string) {
    const rows = await this.db
      .select()
      .from(schema.runs)
      .where(and(eq(schema.runs.id, runId), eq(schema.runs.workspaceId, workspaceId)));
    return getOrThrow(rows, `Run ${runId} was not found`);
  }

  /** A run by its own id, workspace-agnostic — the callback funnel has no workspace
   * context; the per-run token (verified against `callbackTokenHash`) is the auth.
   * Returns undefined for an unknown id (the service maps that to a rejected callback). */
  async findById(runId: string) {
    const [row] = await this.db.select().from(schema.runs).where(eq(schema.runs.id, runId));
    return row;
  }

  /** Patch mutable run fields (state/cursor/timestamps). Scoped by workspace_id even
   * though the id is unique — writes stay tenant-scoped like every other repo write. */
  async update(
    workspaceId: string,
    runId: string,
    patch: Partial<Pick<typeof schema.runs.$inferInsert, 'state' | 'currentIndex' | 'startedAt' | 'finishedAt'>>,
  ) {
    await this.db
      .update(schema.runs)
      .set(patch)
      .where(and(eq(schema.runs.id, runId), eq(schema.runs.workspaceId, workspaceId)));
  }

  /** Runs for a commit, newest-first, scoped to the workspace. */
  async findByCommit(workspaceId: string, commitId: string) {
    return await this.db
      .select()
      .from(schema.runs)
      .where(and(eq(schema.runs.workspaceId, workspaceId), eq(schema.runs.commitId, commitId)))
      .orderBy(desc(schema.runs.createdAt));
  }
}
