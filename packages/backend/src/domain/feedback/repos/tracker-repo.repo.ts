import { and, asc, eq } from 'drizzle-orm';

import * as schema from '@backend/infra/db/schema';

import type { FeedbackScope } from '@backend/domain/feedback/scope';
import type { Db } from '@backend/infra/db/types';

const r = schema.repos;
const pr = schema.projectRepos;
const pc = schema.providerConnections;

const columns = {
  id: r.id,
  workspaceId: r.workspaceId,
  owner: r.owner,
  name: r.name,
  status: r.status,
  externalAccountId: pc.externalAccountId,
  connectionStatus: pc.status,
};

/** A registered repo with the installation that reads it. */
export type FeedbackTrackerRepoRow = Awaited<ReturnType<FeedbackTrackerRepoRepo['ofProject']>>[number];

/** Read-only access to the repos a project links (mocco_project_repos, mocco_repos and their
 * connection) for feedback links: the integration domain owns these tables, feedback only reads
 * which repos a post may link and the installation to read them with. */
export class FeedbackTrackerRepoRepo {
  constructor(private readonly db: Db) {}

  /** The repos linked to the project, by owner and name. */
  async ofProject(scope: FeedbackScope) {
    return await this.db
      .select(columns)
      .from(pr)
      .innerJoin(r, and(eq(r.id, pr.repoId), eq(r.workspaceId, scope.workspaceId)))
      .innerJoin(pc, and(eq(pc.id, r.connectionId), eq(pc.workspaceId, scope.workspaceId)))
      .where(and(eq(pr.workspaceId, scope.workspaceId), eq(pr.projectId, scope.projectId)))
      .orderBy(asc(r.owner), asc(r.name));
  }

  /** One repo linked to the project; undefined for another project's or workspace's repo. */
  async findInProject(scope: FeedbackScope, repoId: string): Promise<FeedbackTrackerRepoRow | undefined> {
    const [row] = await this.db
      .select(columns)
      .from(pr)
      .innerJoin(r, and(eq(r.id, pr.repoId), eq(r.workspaceId, scope.workspaceId)))
      .innerJoin(pc, and(eq(pc.id, r.connectionId), eq(pc.workspaceId, scope.workspaceId)))
      .where(and(eq(pr.workspaceId, scope.workspaceId), eq(pr.projectId, scope.projectId), eq(pr.repoId, repoId)));
    return row;
  }

  /** A workspace's repo by id, linked to a project or not (the backfill refreshes existing links). */
  async findInWorkspace(workspaceId: string, repoId: string): Promise<FeedbackTrackerRepoRow | undefined> {
    const [row] = await this.db
      .select(columns)
      .from(r)
      .innerJoin(pc, and(eq(pc.id, r.connectionId), eq(pc.workspaceId, workspaceId)))
      .where(and(eq(r.workspaceId, workspaceId), eq(r.id, repoId)));
    return row;
  }
}
