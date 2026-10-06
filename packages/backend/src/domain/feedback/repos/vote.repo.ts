import { FeedbackVoteSources, FeedbackVoteStates } from '@mocco/common/feedback';
import { and, count, desc, eq, sql } from 'drizzle-orm';

import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';
import type { FeedbackPage } from '@mocco/common/feedback';

export type FeedbackVoteRow = typeof schema.feedbackVotes.$inferSelect;

const v = schema.feedbackVotes;
const of = (workspaceId: string, postId: string, endUserId: string) =>
  and(eq(v.workspaceId, workspaceId), eq(v.postId, postId), eq(v.endUserId, endUserId));

/** Data access for mocco_feedback_votes. Scoped by workspace; the caller has checked the post's project. */
export class FeedbackVoteRepo {
  constructor(private readonly db: Db) {}

  /** The new vote, or undefined when the end user already has one on the post (the unique
   * index decides, so two concurrent votes insert once). */
  async insertIfAbsent(row: typeof v.$inferInsert): Promise<FeedbackVoteRow | undefined> {
    const [inserted] = await this.db
      .insert(v)
      .values(row)
      .onConflictDoNothing({ target: [v.postId, v.endUserId] })
      .returning();
    return inserted;
  }

  async find(workspaceId: string, postId: string, endUserId: string): Promise<FeedbackVoteRow | undefined> {
    const [row] = await this.db
      .select()
      .from(v)
      .where(of(workspaceId, postId, endUserId));
    return row;
  }

  /** Count a pending vote. Undefined when there is no pending vote (none, or counted already). */
  async markCounted(
    workspaceId: string,
    postId: string,
    endUserId: string,
    at: Date,
  ): Promise<FeedbackVoteRow | undefined> {
    const [row] = await this.db
      .update(v)
      .set({ state: FeedbackVoteStates.counted, countedAt: at })
      .where(and(of(workspaceId, postId, endUserId), eq(v.state, FeedbackVoteStates.pending)))
      .returning();
    return row;
  }

  /** The deleted vote, or undefined when there was none. */
  async delete(workspaceId: string, postId: string, endUserId: string): Promise<FeedbackVoteRow | undefined> {
    const [row] = await this.db
      .delete(v)
      .where(of(workspaceId, postId, endUserId))
      .returning();
    return row;
  }

  /** A post's votes, newest first. */
  async listForPost(workspaceId: string, postId: string, page: FeedbackPage): Promise<FeedbackVoteRow[]> {
    return await this.db
      .select()
      .from(v)
      .where(and(eq(v.workspaceId, workspaceId), eq(v.postId, postId)))
      .orderBy(desc(v.createdAt), desc(v.id))
      .limit(page.limit)
      .offset(page.offset);
  }

  /**
   * Copy `fromPostId`'s votes to `toPostId` as `merge` votes. An end user who voted on both keeps
   * one vote on the target (the unique index), counted if either of theirs was; the source's own
   * rows stay as its history.
   */
  async copyToPost(workspaceId: string, fromPostId: string, toPostId: string): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO ${v} (workspace_id, post_id, end_user_id, state, source, created_at, counted_at)
      SELECT workspace_id, ${toPostId}::uuid, end_user_id, state, ${FeedbackVoteSources.merge}, created_at, counted_at
      FROM ${v}
      WHERE workspace_id = ${workspaceId} AND post_id = ${fromPostId}
      ON CONFLICT (post_id, end_user_id) DO UPDATE
        SET state = excluded.state, counted_at = excluded.counted_at
        WHERE ${v.state} = ${FeedbackVoteStates.pending} AND excluded.state = ${FeedbackVoteStates.counted}`);
  }

  /** How many of the post's votes count: what its `vote_count` must equal. */
  async countCounted(workspaceId: string, postId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(v)
      .where(and(eq(v.workspaceId, workspaceId), eq(v.postId, postId), eq(v.state, FeedbackVoteStates.counted)));
    return row?.n ?? 0;
  }
}
