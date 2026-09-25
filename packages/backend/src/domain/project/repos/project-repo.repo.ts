import { and, asc, eq } from 'drizzle-orm';

import { expectOne } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

/** Data access for mocco_project_repos (project ↔ repo links). The table's composite
 * FKs pin both sides to the same workspace; every query is also workspace-scoped. */
export class ProjectRepoRepo {
  constructor(private readonly db: Db) {}

  /** Link a repo to a project; idempotent — a repeat link returns the existing row. */
  async link(row: typeof schema.projectRepos.$inferInsert) {
    const inserted = await this.db.insert(schema.projectRepos).values(row).onConflictDoNothing().returning();
    if (inserted.length > 0) {
      return expectOne(inserted);
    }
    return expectOne(
      await this.db
        .select()
        .from(schema.projectRepos)
        .where(and(eq(schema.projectRepos.projectId, row.projectId), eq(schema.projectRepos.repoId, row.repoId))),
    );
  }

  /** Remove a link. Scoped by workspace; a missing link is a no-op. */
  async unlink(workspaceId: string, projectId: string, repoId: string) {
    await this.db
      .delete(schema.projectRepos)
      .where(
        and(
          eq(schema.projectRepos.workspaceId, workspaceId),
          eq(schema.projectRepos.projectId, projectId),
          eq(schema.projectRepos.repoId, repoId),
        ),
      );
  }

  /** A project's repo links, oldest first. */
  async listByProject(workspaceId: string, projectId: string) {
    return await this.db
      .select()
      .from(schema.projectRepos)
      .where(and(eq(schema.projectRepos.workspaceId, workspaceId), eq(schema.projectRepos.projectId, projectId)))
      .orderBy(asc(schema.projectRepos.createdAt));
  }
}
