import { and, desc, eq, lt } from 'drizzle-orm';

import { getOrThrow } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

/** Data access for mocco_commits. Commits are immutable once synced — an upsert
 * on (repo_id, sha) does nothing on conflict rather than overwriting. */
export class CommitRepo {
  constructor(private readonly db: Db) {}

  async upsertMany(rows: (typeof schema.commits.$inferInsert)[]) {
    if (rows.length === 0) {
      return;
    }
    await this.db
      .insert(schema.commits)
      .values(rows)
      .onConflictDoNothing({ target: [schema.commits.repoId, schema.commits.sha] });
  }

  /** Newest-first page for a repo, keyed by the opaque `seq` cursor. Fetches
   * `limit + 1` rows so the service can tell whether another page follows and
   * compute `nextCursor` without a second round-trip. */
  async listByRepo(repoId: string, cursor: bigint | null, limit: number) {
    return await this.db
      .select()
      .from(schema.commits)
      .where(
        cursor === null
          ? eq(schema.commits.repoId, repoId)
          : and(eq(schema.commits.repoId, repoId), lt(schema.commits.seq, cursor)),
      )
      .orderBy(desc(schema.commits.seq))
      .limit(limit + 1);
  }

  /** A commit owned by the workspace (via its repo — mocco_commits has no
   * workspace_id of its own), keyed by its own id — or throw EntityNotFoundError
   * for a foreign or unknown id. A commit is NEVER resolved by id alone. */
  async getByIdInWorkspace(workspaceId: string, commitId: string) {
    const rows = await this.db
      .select({ commit: schema.commits })
      .from(schema.commits)
      .innerJoin(schema.repos, eq(schema.commits.repoId, schema.repos.id))
      .where(and(eq(schema.commits.id, commitId), eq(schema.repos.workspaceId, workspaceId)));
    return getOrThrow(
      rows.map(row => row.commit),
      `Commit ${commitId} was not found`,
    );
  }
}
