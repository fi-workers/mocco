import { and, eq } from 'drizzle-orm';

import { RepoStatuses } from '@backend/domain/integration/constants';
import { expectOne, getOrThrow } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

/** Data access for mocco_repos. Every lookup/update is scoped by workspaceId. */
export class RepoRepo {
  constructor(private readonly db: Db) {}

  async findByWorkspace(workspaceId: string) {
    return await this.db.select().from(schema.repos).where(eq(schema.repos.workspaceId, workspaceId));
  }

  /** A repo under a connection, keyed by the provider's own identity
   * (external_repo_id) — or throw EntityNotFoundError for a foreign pair. */
  async getByConnectionAndExternalRepoId(connectionId: string, externalRepoId: string) {
    return getOrThrow(
      await this.db
        .select()
        .from(schema.repos)
        .where(and(eq(schema.repos.connectionId, connectionId), eq(schema.repos.externalRepoId, externalRepoId))),
      `Repo ${externalRepoId} was not found for connection ${connectionId}`,
    );
  }

  /** Mark every repo under a connection inactive — e.g. the installation itself was suspended/deleted. */
  async inactivateByConnection(connectionId: string) {
    await this.db
      .update(schema.repos)
      .set({ status: RepoStatuses.inactive })
      .where(eq(schema.repos.connectionId, connectionId));
  }

  /** Stamp last_synced_at with now — called after a sync pass completes for the repo. */
  async touchLastSynced(repoId: string) {
    await this.db.update(schema.repos).set({ lastSyncedAt: new Date() }).where(eq(schema.repos.id, repoId));
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
