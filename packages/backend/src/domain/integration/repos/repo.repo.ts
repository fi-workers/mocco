import { and, eq } from 'drizzle-orm';

import { expectOne, getOrThrow } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

/** Data access for mocco_repos. Every lookup/update is scoped by workspaceId. */
export class RepoRepo {
  constructor(private readonly db: Db) {}

  async findByWorkspace(workspaceId: string) {
    return await this.db.select().from(schema.repos).where(eq(schema.repos.workspaceId, workspaceId));
  }

  /** Upsert keyed on (connection_id, external_repo_id). */
  async upsert(values: typeof schema.repos.$inferInsert) {
    return expectOne(
      await this.db
        .insert(schema.repos)
        .values(values)
        .onConflictDoUpdate({
          target: [schema.repos.connectionId, schema.repos.externalRepoId],
          set: { watchedBranch: values.watchedBranch, status: 'active' },
        })
        .returning(),
    );
  }

  /** Update a workspace's repo watched branch, or throw EntityNotFoundError if none. */
  async updateWatchedBranch(workspaceId: string, repoId: string, watchedBranch: string | null) {
    return getOrThrow(
      await this.db
        .update(schema.repos)
        .set({ watchedBranch })
        .where(and(eq(schema.repos.id, repoId), eq(schema.repos.workspaceId, workspaceId)))
        .returning(),
      `Repo ${repoId} was not found`,
    );
  }
}
