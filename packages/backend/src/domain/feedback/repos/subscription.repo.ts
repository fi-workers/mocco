import { and, asc, eq, isNull, sql } from 'drizzle-orm';

import { expectOne } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';
import type { FeedbackPage } from '@mocco/common/feedback';

export type FeedbackSubscriptionRow = typeof schema.feedbackSubscriptions.$inferSelect;

const s = schema.feedbackSubscriptions;

/** Data access for mocco_feedback_subscriptions. Scoped by workspace; the caller has checked the post's project. */
export class FeedbackSubscriptionRepo {
  constructor(private readonly db: Db) {}

  /** Subscribe unless the end user has a row already, active or opted out (an opt-out stands). */
  async insertIfAbsent(workspaceId: string, postId: string, endUserId: string): Promise<void> {
    await this.db
      .insert(s)
      .values({ workspaceId, postId, endUserId })
      .onConflictDoNothing({ target: [s.postId, s.endUserId] });
  }

  /** Subscribe, clearing an earlier opt-out. */
  async subscribe(workspaceId: string, postId: string, endUserId: string): Promise<FeedbackSubscriptionRow> {
    return expectOne(
      await this.db
        .insert(s)
        .values({ workspaceId, postId, endUserId })
        .onConflictDoUpdate({ target: [s.postId, s.endUserId], set: { unsubscribedAt: null } })
        .returning(),
    );
  }

  /** Opt out, keeping the row so voting again doesn't resubscribe. */
  async unsubscribe(
    workspaceId: string,
    postId: string,
    endUserId: string,
    at: Date,
  ): Promise<FeedbackSubscriptionRow> {
    return expectOne(
      await this.db
        .insert(s)
        .values({ workspaceId, postId, endUserId, unsubscribedAt: at })
        .onConflictDoUpdate({
          target: [s.postId, s.endUserId],
          set: { unsubscribedAt: sql`coalesce(${s.unsubscribedAt}, excluded.unsubscribed_at)` },
        })
        .returning(),
    );
  }

  /** A post's active subscribers, oldest first. */
  async listActive(workspaceId: string, postId: string, page: FeedbackPage): Promise<FeedbackSubscriptionRow[]> {
    return await this.db
      .select()
      .from(s)
      .where(and(eq(s.workspaceId, workspaceId), eq(s.postId, postId), isNull(s.unsubscribedAt)))
      .orderBy(asc(s.createdAt), asc(s.id))
      .limit(page.limit)
      .offset(page.offset);
  }

  /** Copy `fromPostId`'s subscriptions to `toPostId`. A row the end user already has on the
   * target wins (it is their latest choice there); opt-outs copy as opt-outs. */
  async copyToPost(workspaceId: string, fromPostId: string, toPostId: string): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO ${s} (workspace_id, post_id, end_user_id, created_at, unsubscribed_at)
      SELECT workspace_id, ${toPostId}::uuid, end_user_id, created_at, unsubscribed_at
      FROM ${s}
      WHERE workspace_id = ${workspaceId} AND post_id = ${fromPostId}
      ON CONFLICT (post_id, end_user_id) DO NOTHING`);
  }
}
