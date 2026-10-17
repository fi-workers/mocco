import { FeedbackStatusMailStates, FeedbackVoteStates } from '@mocco/common/feedback';
import { and, asc, eq, gt, inArray, isNull, lt, lte, ne, notExists, sql } from 'drizzle-orm';
import { z } from 'zod';

import { EMAIL_END_USER_PREFIX } from '@backend/domain/feedback/EmailVoteService';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

export type FeedbackStatusChangeRow = typeof schema.feedbackStatusChanges.$inferSelect;
export type FeedbackStatusMailRow = typeof schema.feedbackStatusMails.$inferSelect;

/** A `count(*)::int AS count` answer. */
const countSchema = z.object({ rows: z.array(z.object({ count: z.coerce.number() })) });

const c = schema.feedbackStatusChanges;
const m = schema.feedbackStatusMails;
const s = schema.feedbackSubscriptions;
const v = schema.feedbackVotes;
const o = schema.feedbackMailOptOuts;
const posts = schema.feedbackPosts;
const boards = schema.feedbackBoards;
const { projects } = schema;

/** Data access for status-change mails (#180). The jobs that use it scan every tenant; each row
 * carries its workspace. */
export class FeedbackStatusMailRepo {
  constructor(private readonly db: Db) {}

  /** Status changes not settled yet, made at or before `before`, oldest first; locked and skipped
   * by a concurrent run. */
  async lockDueChanges(before: Date, limit: number): Promise<FeedbackStatusChangeRow[]> {
    return await this.db
      .select()
      .from(c)
      .where(and(isNull(c.notifiedAt), lte(c.createdAt, before)))
      .orderBy(asc(c.createdAt))
      .limit(limit)
      .for('update', { skipLocked: true });
  }

  /** Whether the post moved again after this change. Compared in SQL against the stored time:
   * a JS Date keeps milliseconds, the column microseconds, so the change would look newer than itself. */
  async hasNewerChange(change: FeedbackStatusChangeRow): Promise<boolean> {
    const own = this.db.select({ at: c.createdAt }).from(c).where(eq(c.id, change.id));
    const [row] = await this.db
      .select({ id: c.id })
      .from(c)
      .where(and(eq(c.postId, change.postId), ne(c.id, change.id), gt(c.createdAt, own)))
      .limit(1);
    return row !== undefined;
  }

  async markNotified(changeId: string, at: Date): Promise<void> {
    await this.db.update(c).set({ notifiedAt: at }).where(eq(c.id, changeId));
  }

  /**
   * Queue a mail for each follower of the post who can be mailed: an email voter (`email:` id),
   * still following, whose vote on the post counts (their address is confirmed), who hasn't
   * stopped all mail from the project. Followers who already have one for this change get nothing
   * new. Returns how many were queued.
   */
  async queueForChange(change: FeedbackStatusChangeRow): Promise<number> {
    const result = await this.db.execute(sql`
      WITH queued AS (
        INSERT INTO ${m} (workspace_id, status_change_id, end_user_id)
        SELECT ${s.workspaceId}, ${change.id}::uuid, ${s.endUserId}
        FROM ${s}
        JOIN ${v} ON ${v.postId} = ${s.postId} AND ${v.endUserId} = ${s.endUserId} AND ${v.state} = ${FeedbackVoteStates.counted}
        WHERE ${s.postId} = ${change.postId}::uuid
          AND ${s.workspaceId} = ${change.workspaceId}::uuid
          AND ${s.unsubscribedAt} IS NULL
          AND starts_with(${s.endUserId}, ${EMAIL_END_USER_PREFIX})
          AND NOT EXISTS (
            SELECT 1 FROM ${o}
            JOIN ${posts} ON ${posts.id} = ${s.postId}
            WHERE ${o.projectId} = ${posts.projectId} AND ${o.endUserId} = ${s.endUserId}
          )
        ON CONFLICT DO NOTHING
        RETURNING 1
      )
      SELECT count(*)::int AS count FROM queued`);
    const [row] = countSchema.parse(result).rows;
    return row?.count ?? 0;
  }

  /** Claim up to `limit` queued mails, oldest first: `sending`, one more attempt. */
  async claimQueued(now: Date, limit: number): Promise<FeedbackStatusMailRow[]> {
    const queued = this.db
      .select({ id: m.id })
      .from(m)
      .where(eq(m.state, FeedbackStatusMailStates.queued))
      .orderBy(asc(m.createdAt))
      .limit(limit)
      .for('update', { skipLocked: true });
    return await this.db
      .update(m)
      .set({ state: FeedbackStatusMailStates.sending, claimedAt: now, attempts: sql`${m.attempts} + 1` })
      .where(inArray(m.id, queued))
      .returning();
  }

  /** A claim older than `before` belongs to a run that died, perhaps after the relay took the
   * mail: give it up rather than send it twice. Returns how many. */
  async giveUpStale(before: Date): Promise<number> {
    const rows = await this.db
      .update(m)
      .set({ state: FeedbackStatusMailStates.failed, error: 'The send was interrupted' })
      .where(and(eq(m.state, FeedbackStatusMailStates.sending), lt(m.claimedAt, before)))
      .returning({ id: m.id });
    return rows.length;
  }

  async settle(
    id: string,
    values: Partial<Pick<FeedbackStatusMailRow, 'state' | 'sentAt' | 'error' | 'claimedAt'>>,
  ): Promise<void> {
    await this.db.update(m).set(values).where(eq(m.id, id));
  }

  async findChange(id: string): Promise<FeedbackStatusChangeRow | undefined> {
    const [row] = await this.db.select().from(c).where(eq(c.id, id));
    return row;
  }

  /** What a mail about the post says and links to: its title, number, board and project. */
  async postContext(postId: string) {
    const [row] = await this.db
      .select({
        workspaceId: posts.workspaceId,
        projectId: posts.projectId,
        postId: posts.id,
        title: posts.title,
        number: posts.number,
        status: posts.status,
        mergedIntoPostId: posts.mergedIntoPostId,
        boardSlug: boards.slug,
        isPublic: boards.isPublic,
        projectName: projects.name,
      })
      .from(posts)
      .innerJoin(boards, eq(boards.id, posts.boardId))
      .innerJoin(projects, eq(projects.id, posts.projectId))
      .where(eq(posts.id, postId));
    return row;
  }

  /** Whether the end user still follows the post and hasn't stopped all mail from its project. */
  async isFollowing(postId: string, projectId: string, endUserId: string): Promise<boolean> {
    const optedOut = this.db
      .select({ id: o.id })
      .from(o)
      .where(and(eq(o.projectId, projectId), eq(o.endUserId, endUserId)));
    const [row] = await this.db
      .select({ id: s.id })
      .from(s)
      .where(and(eq(s.postId, postId), eq(s.endUserId, endUserId), isNull(s.unsubscribedAt), notExists(optedOut)));
    return row !== undefined;
  }
}
