import { GateStates } from '@mocco/common/governance';
import { and, asc, desc, eq, gte, isNotNull, lt, lte, sql } from 'drizzle-orm';

import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';
import type { RunState } from '@mocco/common/execution';

/** Data access for mocco_releases (the release registry). Reads are workspace-scoped. */
export class ReleaseRepo {
  constructor(private readonly db: Db) {}

  /** Insert releases, skipping any (project, run) that already has one. Returns the rows
   * actually inserted, so a repeat is a no-op that returns nothing. */
  async insertMissing(rows: (typeof schema.releases.$inferInsert)[]) {
    if (rows.length === 0) {
      return [];
    }
    return await this.db
      .insert(schema.releases)
      .values(rows)
      .onConflictDoNothing({ target: [schema.releases.projectId, schema.releases.runId] })
      .returning();
  }

  /** The releases recorded for a run, one per project. */
  async listByRun(workspaceId: string, runId: string) {
    return await this.db
      .select()
      .from(schema.releases)
      .where(and(eq(schema.releases.workspaceId, workspaceId), eq(schema.releases.runId, runId)))
      .orderBy(asc(schema.releases.createdAt));
  }

  /** The latest release of a repo strictly before `releasedAt`, or undefined for its first. */
  async findPreviousForRepo(workspaceId: string, repoId: string, releasedAt: Date) {
    const [row] = await this.db
      .select()
      .from(schema.releases)
      .where(
        and(
          eq(schema.releases.workspaceId, workspaceId),
          eq(schema.releases.repoId, repoId),
          lt(schema.releases.releasedAt, releasedAt),
        ),
      )
      .orderBy(desc(schema.releases.releasedAt))
      .limit(1);
    return row;
  }

  /** A project's releases, newest first. `before` is the previous page's last `releasedAt`. */
  async listByProject(workspaceId: string, projectId: string, filter: { limit: number; before?: Date }) {
    return await this.db
      .select()
      .from(schema.releases)
      .where(
        and(
          eq(schema.releases.workspaceId, workspaceId),
          eq(schema.releases.projectId, projectId),
          ...(filter.before === undefined ? [] : [lt(schema.releases.releasedAt, filter.before)]),
        ),
      )
      .orderBy(desc(schema.releases.releasedAt))
      .limit(filter.limit);
  }

  /**
   * Releases between `from` and `to` (inclusive), oldest first, with a run that still exists.
   * With `projectId`, only that project's releases of repos it still links, so a repo unlinked
   * since is left out; without it, every release in the workspace.
   */
  async listReleasedBetween(workspaceId: string, window: { from: Date; to: Date; projectId?: string }) {
    const { releases, projectRepos } = schema;
    const conditions = [
      eq(releases.workspaceId, workspaceId),
      gte(releases.releasedAt, window.from),
      lte(releases.releasedAt, window.to),
      isNotNull(releases.runId),
      ...(window.projectId === undefined
        ? []
        : [
            eq(releases.projectId, window.projectId),
            sql`EXISTS (SELECT 1 FROM ${projectRepos} WHERE ${projectRepos.projectId} = ${releases.projectId} AND ${projectRepos.repoId} = ${releases.repoId})`,
          ]),
    ];
    return await this.db
      .select()
      .from(releases)
      .where(and(...conditions))
      .orderBy(asc(releases.releasedAt));
  }

  /**
   * Released runs the registry may have missed, oldest first: runs in `state` that finished
   * at or after `since`, passed at least one resumed gate and whose repo is linked to a
   * project, with no release row yet or no event with the dedupe key
   * `<eventDedupePrefix><runId>`. Across workspaces (the reconcile job is a platform schedule).
   */
  async findUnrecorded(filter: { state: RunState; since: Date; eventDedupePrefix: string; limit: number }) {
    const { runs, commits, projectRepos, runGates, releases, domainEvents } = schema;
    return await this.db
      .select({ runId: runs.id, workspaceId: runs.workspaceId, finishedAt: runs.finishedAt })
      .from(runs)
      .innerJoin(commits, eq(commits.id, runs.commitId))
      .where(
        and(
          eq(runs.state, filter.state),
          gte(runs.finishedAt, filter.since),
          sql`EXISTS (SELECT 1 FROM ${runGates} WHERE ${runGates.runId} = ${runs.id} AND ${runGates.state} = ${GateStates.resumed})`,
          sql`EXISTS (SELECT 1 FROM ${projectRepos} WHERE ${projectRepos.repoId} = ${commits.repoId} AND ${projectRepos.workspaceId} = ${runs.workspaceId})`,
          sql`(
            NOT EXISTS (SELECT 1 FROM ${releases} WHERE ${releases.runId} = ${runs.id})
            OR NOT EXISTS (SELECT 1 FROM ${domainEvents} WHERE ${domainEvents.workspaceId} = ${runs.workspaceId} AND ${domainEvents.dedupeKey} = ${filter.eventDedupePrefix} || ${runs.id}::text)
          )`,
        ),
      )
      .orderBy(asc(runs.finishedAt))
      .limit(filter.limit);
  }
}
