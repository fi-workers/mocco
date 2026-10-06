import { and, asc, eq } from 'drizzle-orm';

import { expectOne } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';
import type { FeedbackPage } from '@mocco/common/feedback';

export type FeedbackCommentRow = typeof schema.feedbackComments.$inferSelect;

const c = schema.feedbackComments;

/** Data access for mocco_feedback_comments. Scoped by workspace; the caller has checked the post's project. */
export class FeedbackCommentRepo {
  constructor(private readonly db: Db) {}

  async insert(row: typeof c.$inferInsert): Promise<FeedbackCommentRow> {
    return expectOne(await this.db.insert(c).values(row).returning());
  }

  /** A post's comments, oldest first; internal notes only when `withInternal`. */
  async listForPost(
    workspaceId: string,
    postId: string,
    options: FeedbackPage & { withInternal: boolean },
  ): Promise<FeedbackCommentRow[]> {
    return await this.db
      .select()
      .from(c)
      .where(
        and(
          eq(c.workspaceId, workspaceId),
          eq(c.postId, postId),
          options.withInternal ? undefined : eq(c.isInternal, false),
        ),
      )
      .orderBy(asc(c.createdAt), asc(c.id))
      .limit(options.limit)
      .offset(options.offset);
  }
}
