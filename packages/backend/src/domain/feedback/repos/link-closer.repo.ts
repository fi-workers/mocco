import { and, asc, eq, inArray } from 'drizzle-orm';

import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

export type FeedbackLinkCloserRow = typeof schema.feedbackLinkClosers.$inferSelect;
export type FeedbackLinkCloserFields = Pick<
  FeedbackLinkCloserRow,
  'prNumber' | 'externalNodeId' | 'title' | 'url' | 'state' | 'mergeCommitSha' | 'mergedAt'
>;

const c = schema.feedbackLinkClosers;

/** Data access for mocco_feedback_link_closers: the pull requests closing a linked issue. Scoped by
 * workspace; staff reach them only through a link of their project. */
export class FeedbackLinkCloserRepo {
  constructor(private readonly db: Db) {}

  /** Make the issue link's closers exactly `closers`. */
  async replace(
    link: { id: string; workspaceId: string; repoId: string },
    closers: readonly FeedbackLinkCloserFields[],
    now: Date,
  ): Promise<void> {
    await this.db.transaction(async tx => {
      await tx.delete(c).where(and(eq(c.workspaceId, link.workspaceId), eq(c.linkId, link.id)));
      if (closers.length > 0) {
        await tx.insert(c).values(
          closers.map(closer => ({
            ...closer,
            workspaceId: link.workspaceId,
            linkId: link.id,
            repoId: link.repoId,
            createdAt: now,
            updatedAt: now,
          })),
        );
      }
    });
  }

  /** The closers of these links, by pull request number. */
  async ofLinks(workspaceId: string, linkIds: readonly string[]): Promise<FeedbackLinkCloserRow[]> {
    if (linkIds.length === 0) {
      return [];
    }
    return await this.db
      .select()
      .from(c)
      .where(and(eq(c.workspaceId, workspaceId), inArray(c.linkId, [...linkIds])))
      .orderBy(asc(c.prNumber));
  }

  /** Record what a pull request is now on every closer row for it; how many rows that was. */
  async refreshPullRequest(
    workspaceId: string,
    repoId: string,
    fields: FeedbackLinkCloserFields,
    now: Date,
  ): Promise<number> {
    const updated = await this.db
      .update(c)
      .set({ ...fields, updatedAt: now })
      .where(and(eq(c.workspaceId, workspaceId), eq(c.repoId, repoId), eq(c.prNumber, fields.prNumber)))
      .returning({ id: c.id });
    return updated.length;
  }
}
