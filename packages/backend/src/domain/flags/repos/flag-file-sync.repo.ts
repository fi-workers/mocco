import { and, desc, eq } from 'drizzle-orm';

import { expectOne } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

export type FlagFileSyncRow = typeof schema.flagFileSyncs.$inferSelect;

/** Data access for `.mocco/flags.yml` syncs (#145). Every query is scoped by `workspace_id`. */
export class FlagFileSyncRepo {
  constructor(private readonly db: Db) {}

  async insert(row: typeof schema.flagFileSyncs.$inferInsert) {
    return expectOne(await this.db.insert(schema.flagFileSyncs).values(row).returning());
  }

  /** The project's syncs, newest first. */
  async listByProject(workspaceId: string, projectId: string, limit: number) {
    return await this.db
      .select()
      .from(schema.flagFileSyncs)
      .where(and(eq(schema.flagFileSyncs.workspaceId, workspaceId), eq(schema.flagFileSyncs.projectId, projectId)))
      .orderBy(desc(schema.flagFileSyncs.createdAt))
      .limit(limit);
  }

  /** The projects a repo is linked to. */
  async projectsOfRepo(workspaceId: string, repoId: string) {
    const rows = await this.db
      .select({ projectId: schema.projectRepos.projectId })
      .from(schema.projectRepos)
      .where(and(eq(schema.projectRepos.workspaceId, workspaceId), eq(schema.projectRepos.repoId, repoId)));
    return rows.map(row => row.projectId);
  }

  /** The workspace member who signed in with this GitHub account, if any. */
  async memberByGithubAccount(workspaceId: string, githubUserId: string) {
    const [row] = await this.db
      .select({ userId: schema.accounts.userId })
      .from(schema.accounts)
      .innerJoin(
        schema.members,
        and(eq(schema.members.userId, schema.accounts.userId), eq(schema.members.organizationId, workspaceId)),
      )
      .where(and(eq(schema.accounts.providerId, 'github'), eq(schema.accounts.accountId, githubUserId)));
    return row?.userId;
  }

  /** The workspace member with this verified email, if any. */
  async memberByVerifiedEmail(workspaceId: string, email: string) {
    const [row] = await this.db
      .select({ userId: schema.users.id })
      .from(schema.users)
      .innerJoin(
        schema.members,
        and(eq(schema.members.userId, schema.users.id), eq(schema.members.organizationId, workspaceId)),
      )
      // eslint-disable-next-line sonarjs/null-dereference -- email is a string, never null
      .where(and(eq(schema.users.email, email.toLowerCase()), eq(schema.users.emailVerified, true)));
    return row?.userId;
  }
}
