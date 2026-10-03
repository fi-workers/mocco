import { RunStates } from '@mocco/common/execution';
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

  /** The repo's last successful run and its commit, with what's needed to fetch its code. */
  async lastDeploy(workspaceId: string, repoId: string) {
    const [row] = await this.db
      .select({
        runId: schema.runs.id,
        commitSha: schema.commits.sha,
        owner: schema.repos.owner,
        name: schema.repos.name,
        externalAccountId: schema.providerConnections.externalAccountId,
      })
      .from(schema.runs)
      .innerJoin(schema.commits, eq(schema.runs.commitId, schema.commits.id))
      .innerJoin(schema.repos, eq(schema.commits.repoId, schema.repos.id))
      .innerJoin(schema.providerConnections, eq(schema.repos.connectionId, schema.providerConnections.id))
      .where(
        and(
          eq(schema.runs.workspaceId, workspaceId),
          eq(schema.commits.repoId, repoId),
          eq(schema.runs.state, RunStates.succeeded),
        ),
      )
      .orderBy(desc(schema.runs.finishedAt))
      .limit(1);
    return row;
  }

  async findScan(workspaceId: string, repoId: string, commitSha: string) {
    const [row] = await this.db
      .select()
      .from(schema.flagCodeScans)
      .where(
        and(
          eq(schema.flagCodeScans.workspaceId, workspaceId),
          eq(schema.flagCodeScans.repoId, repoId),
          eq(schema.flagCodeScans.commitSha, commitSha),
        ),
      );
    return row;
  }

  async saveScan(row: typeof schema.flagCodeScans.$inferInsert) {
    await this.db
      .insert(schema.flagCodeScans)
      .values(row)
      .onConflictDoUpdate({
        target: [schema.flagCodeScans.repoId, schema.flagCodeScans.commitSha],
        set: { scannedKeys: row.scannedKeys, foundKeys: row.foundKeys, isComplete: row.isComplete },
      });
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
