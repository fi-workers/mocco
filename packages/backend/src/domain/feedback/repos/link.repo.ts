import { and, asc, eq, lt } from 'drizzle-orm';

import * as schema from '@backend/infra/db/schema';

import type { FeedbackScope } from '@backend/domain/feedback/scope';
import type { Db } from '@backend/infra/db/types';
import type { FeedbackLinkKind } from '@mocco/common/feedback';

export type FeedbackLinkRow = typeof schema.feedbackLinks.$inferSelect;
/** What the provider says an issue or pull request is now. */
export type FeedbackLinkLiveFields = Pick<
  FeedbackLinkRow,
  'externalNodeId' | 'title' | 'url' | 'state' | 'mergeCommitSha' | 'mergedAt'
>;

const l = schema.feedbackLinks;
const scoped = (scope: FeedbackScope) => and(eq(l.workspaceId, scope.workspaceId), eq(l.projectId, scope.projectId));

/** Data access for mocco_feedback_links. Staff reads are scoped by workspace and project; the
 * webhook fan-in by workspace and repo (both resolved through the installation's connection). */
export class FeedbackLinkRepo {
  constructor(private readonly db: Db) {}

  /** The new link; undefined when the post links that issue or pull request already. */
  async insert(row: typeof l.$inferInsert): Promise<FeedbackLinkRow | undefined> {
    const [inserted] = await this.db
      .insert(l)
      .values(row)
      .onConflictDoNothing({ target: [l.postId, l.repoId, l.kind, l.externalNumber] })
      .returning();
    return inserted;
  }

  /** One of the project's links; undefined when it has no such link. */
  async find(scope: FeedbackScope, linkId: string): Promise<FeedbackLinkRow | undefined> {
    const [found] = await this.db
      .select()
      .from(l)
      .where(and(scoped(scope), eq(l.id, linkId)));
    return found;
  }

  /** A post's links, oldest first. */
  async ofPost(scope: FeedbackScope, postId: string): Promise<FeedbackLinkRow[]> {
    return await this.db
      .select()
      .from(l)
      .where(and(scoped(scope), eq(l.postId, postId)))
      .orderBy(asc(l.createdAt));
  }

  /** Remove a link (its closers go with it); undefined when the project has no such link. */
  async delete(scope: FeedbackScope, linkId: string): Promise<FeedbackLinkRow | undefined> {
    const [deleted] = await this.db
      .delete(l)
      .where(and(scoped(scope), eq(l.id, linkId)))
      .returning();
    return deleted;
  }

  /** Every post's link to one issue or pull request of a repo. */
  async findByTarget(workspaceId: string, repoId: string, kind: FeedbackLinkKind, externalNumber: number) {
    return await this.db
      .select()
      .from(l)
      .where(
        and(
          eq(l.workspaceId, workspaceId),
          eq(l.repoId, repoId),
          eq(l.kind, kind),
          eq(l.externalNumber, externalNumber),
        ),
      );
  }

  /** Record what the provider says the link's target is now. */
  async refresh(workspaceId: string, linkId: string, fields: FeedbackLinkLiveFields, now: Date): Promise<void> {
    await this.db
      .update(l)
      .set({ ...fields, refreshedAt: now, updatedAt: now })
      .where(and(eq(l.workspaceId, workspaceId), eq(l.id, linkId)));
  }

  /** Mark the link read now without changing what it says (the backfill took its turn). */
  async touch(workspaceId: string, linkId: string, now: Date): Promise<void> {
    await this.db
      .update(l)
      .set({ refreshedAt: now })
      .where(and(eq(l.workspaceId, workspaceId), eq(l.id, linkId)));
  }

  /** Links last refreshed before `before`, the longest ago first, across workspaces (the backfill). */
  async staleBefore(before: Date, limit: number): Promise<FeedbackLinkRow[]> {
    return await this.db.select().from(l).where(lt(l.refreshedAt, before)).orderBy(asc(l.refreshedAt)).limit(limit);
  }
}
