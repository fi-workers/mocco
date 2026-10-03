import { and, desc, eq } from 'drizzle-orm';

import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

/** Reads for an environment's timeline (#146): the runs of its linked repo's pipeline. */
export class FlagTimelineRepo {
  constructor(private readonly db: Db) {}

  /** The repo's runs, newest first, with the commit each ran. */
  async runsOfRepo(workspaceId: string, repoId: string, limit: number) {
    return await this.db
      .select({
        id: schema.runs.id,
        state: schema.runs.state,
        commitSha: schema.commits.sha,
        commitMessage: schema.commits.message,
        branch: schema.commits.branch,
        createdAt: schema.runs.createdAt,
        finishedAt: schema.runs.finishedAt,
      })
      .from(schema.runs)
      .innerJoin(schema.commits, eq(schema.runs.commitId, schema.commits.id))
      .where(and(eq(schema.runs.workspaceId, workspaceId), eq(schema.commits.repoId, repoId)))
      .orderBy(desc(schema.runs.createdAt))
      .limit(limit);
  }

  /** Whether the repo is linked to the project. */
  async isLinked(workspaceId: string, projectId: string, repoId: string) {
    const [row] = await this.db
      .select({ repoId: schema.projectRepos.repoId })
      .from(schema.projectRepos)
      .where(
        and(
          eq(schema.projectRepos.workspaceId, workspaceId),
          eq(schema.projectRepos.projectId, projectId),
          eq(schema.projectRepos.repoId, repoId),
        ),
      );
    return row !== undefined;
  }
}
