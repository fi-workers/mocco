import { FeedbackDuplicateStates } from '@mocco/common/feedback';
import { aliasedTable, and, asc, count, desc, eq, inArray, isNull } from 'drizzle-orm';

import * as schema from '@backend/infra/db/schema';

import type { FeedbackPostRow } from '@backend/domain/feedback/repos/post.repo';
import type { FeedbackScope } from '@backend/domain/feedback/scope';
import type { Db } from '@backend/infra/db/types';

export type FeedbackDuplicateCandidateRow = typeof schema.feedbackDuplicateCandidates.$inferSelect;

/** An open pair with both posts, for the staff queue. */
export interface FeedbackDuplicatePair {
  candidate: FeedbackDuplicateCandidateRow;
  post: FeedbackPostRow;
  original: FeedbackPostRow;
}

const d = schema.feedbackDuplicateCandidates;
const p = schema.feedbackPosts;
const newer = aliasedTable(p, 'newer');
const older = aliasedTable(p, 'older');
const scoped = (scope: FeedbackScope) => and(eq(d.workspaceId, scope.workspaceId), eq(d.projectId, scope.projectId));

/** Open pairs whose posts are both still unmerged: merging either one takes the pair out. */
const live = and(
  eq(d.state, FeedbackDuplicateStates.open),
  isNull(newer.mergedIntoPostId),
  isNull(older.mergedIntoPostId),
);

/** Data access for mocco_feedback_duplicate_candidates, and the sweep's reads of posts. */
export class FeedbackDuplicateCandidateRepo {
  constructor(private readonly db: Db) {}

  /** Posts the sweep hasn't compared yet, oldest first, across every workspace. */
  async unchecked(limit: number): Promise<FeedbackPostRow[]> {
    return await this.db
      .select()
      .from(p)
      .where(isNull(p.duplicatesCheckedAt))
      .orderBy(asc(p.createdAt), asc(p.id))
      .limit(limit);
  }

  async markChecked(postIds: readonly string[], at: Date): Promise<void> {
    if (postIds.length === 0) {
      return;
    }
    await this.db
      .update(p)
      .set({ duplicatesCheckedAt: at })
      .where(inArray(p.id, [...postIds]));
  }

  /** Record pairs; a pair already there (open or dismissed) is left as it is. */
  async insertMany(rows: readonly (typeof d.$inferInsert)[]): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    await this.db
      .insert(d)
      .values([...rows])
      .onConflictDoNothing({ target: [d.postId, d.candidatePostId] });
  }

  /** A board's open pairs, the newest first. */
  async listOpen(scope: FeedbackScope, boardId: string, limit: number): Promise<FeedbackDuplicatePair[]> {
    const rows = await this.db
      .select({ candidate: d, post: newer, original: older })
      .from(d)
      .innerJoin(newer, eq(newer.id, d.postId))
      .innerJoin(older, eq(older.id, d.candidatePostId))
      .where(and(scoped(scope), eq(d.boardId, boardId), live))
      .orderBy(desc(d.createdAt), desc(d.score))
      .limit(limit);
    return rows;
  }

  async countOpen(scope: FeedbackScope, boardId: string): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(d)
      .innerJoin(newer, eq(newer.id, d.postId))
      .innerJoin(older, eq(older.id, d.candidatePostId))
      .where(and(scoped(scope), eq(d.boardId, boardId), live));
    return row?.value ?? 0;
  }

  /** Set an open pair aside; undefined when the scope has no such open pair. */
  async dismiss(
    scope: FeedbackScope,
    id: string,
    by: { userId: string; at: Date },
  ): Promise<FeedbackDuplicateCandidateRow | undefined> {
    const [row] = await this.db
      .update(d)
      .set({ state: FeedbackDuplicateStates.dismissed, dismissedAt: by.at, dismissedByUserId: by.userId })
      .where(and(scoped(scope), eq(d.id, id), eq(d.state, FeedbackDuplicateStates.open)))
      .returning();
    return row;
  }

  async get(scope: FeedbackScope, id: string): Promise<FeedbackDuplicateCandidateRow | undefined> {
    const [row] = await this.db
      .select()
      .from(d)
      .where(and(scoped(scope), eq(d.id, id)))
      .limit(1);
    return row;
  }
}
