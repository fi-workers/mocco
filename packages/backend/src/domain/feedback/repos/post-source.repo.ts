import { and, asc, eq, inArray } from 'drizzle-orm';

import * as schema from '@backend/infra/db/schema';

import type { FeedbackScope } from '@backend/domain/feedback/scope';
import type { Db } from '@backend/infra/db/types';
import type { FeedbackSourceType } from '@mocco/common/feedback';

export type FeedbackPostSourceRow = typeof schema.feedbackPostSources.$inferSelect;

const s = schema.feedbackPostSources;
const p = schema.feedbackPosts;
const scoped = (scope: FeedbackScope) => and(eq(s.workspaceId, scope.workspaceId), eq(s.projectId, scope.projectId));

/** Data access for mocco_feedback_post_sources. Scoped by workspace and project. */
export class FeedbackPostSourceRepo {
  constructor(private readonly db: Db) {}

  /** Record that `postId` came from the source; undefined when that link exists already. */
  async insert(row: typeof s.$inferInsert): Promise<FeedbackPostSourceRow | undefined> {
    const [inserted] = await this.db
      .insert(s)
      .values(row)
      .onConflictDoNothing({ target: [s.sourceType, s.sourceId, s.postId] })
      .returning();
    return inserted;
  }

  /** The posts a source became, oldest link first, with the post. */
  async postsOf(scope: FeedbackScope, sourceType: FeedbackSourceType, sourceId: string) {
    return await this.db
      .select({ source: s, post: p })
      .from(s)
      .innerJoin(p, eq(p.id, s.postId))
      .where(and(scoped(scope), eq(s.sourceType, sourceType), eq(s.sourceId, sourceId)))
      .orderBy(asc(s.createdAt));
  }

  /** Forget sources (their words and requester), e.g. when the product erases them for privacy.
   * The posts stay: they are the team's now. */
  async deleteSources(
    workspaceId: string,
    sourceType: FeedbackSourceType,
    sourceIds: readonly string[],
  ): Promise<void> {
    if (sourceIds.length === 0) {
      return;
    }
    await this.db
      .delete(s)
      .where(and(eq(s.workspaceId, workspaceId), eq(s.sourceType, sourceType), inArray(s.sourceId, [...sourceIds])));
  }

  /** Where a post came from, oldest first. */
  async ofPost(scope: FeedbackScope, postId: string): Promise<FeedbackPostSourceRow[]> {
    return await this.db
      .select()
      .from(s)
      .where(and(scoped(scope), eq(s.postId, postId)))
      .orderBy(asc(s.createdAt));
  }
}
