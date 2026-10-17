import { ShipSuggestionStates } from '@mocco/common/feedback';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';

import * as schema from '@backend/infra/db/schema';

import type { FeedbackScope } from '@backend/domain/feedback/scope';
import type { Db } from '@backend/infra/db/types';
import type { ShipSuggestionState } from '@mocco/common/feedback';

export type ShipSuggestionRow = typeof schema.feedbackShipSuggestions.$inferSelect;

const s = schema.feedbackShipSuggestions;
const posts = schema.feedbackPosts;
const scoped = (scope: FeedbackScope) => and(eq(s.workspaceId, scope.workspaceId), eq(s.projectId, scope.projectId));

/** Data access for mocco_feedback_ship_suggestions (#179). Staff reads are scoped by workspace and
 * project; the detector writes by workspace and board, both from the release it handles. */
export class ShipSuggestionRepo {
  constructor(private readonly db: Db) {}

  /** Insert the suggestions a (post, run) pair doesn't have yet; returns only the new ones. */
  async insertMissing(rows: readonly (typeof s.$inferInsert)[]): Promise<ShipSuggestionRow[]> {
    if (rows.length === 0) {
      return [];
    }
    return await this.db
      .insert(s)
      .values([...rows])
      .onConflictDoNothing({ target: [s.postId, s.runId] })
      .returning();
  }

  /** A board's suggestions from one run, in any state, oldest first. */
  async ofRun(workspaceId: string, boardId: string, runId: string): Promise<ShipSuggestionRow[]> {
    return await this.db
      .select()
      .from(s)
      .where(and(eq(s.workspaceId, workspaceId), eq(s.boardId, boardId), eq(s.runId, runId)))
      .orderBy(asc(s.createdAt), asc(s.id));
  }

  /** Which of these posts have a suggestion still waiting for the team (from any run). */
  async postsWithPending(workspaceId: string, postIds: readonly string[]): Promise<Set<string>> {
    if (postIds.length === 0) {
      return new Set();
    }
    const rows = await this.db
      .selectDistinct({ postId: s.postId })
      .from(s)
      .where(
        and(eq(s.workspaceId, workspaceId), inArray(s.postId, [...postIds]), eq(s.state, ShipSuggestionStates.pending)),
      );
    return new Set(rows.map(row => row.postId));
  }

  /** Point these suggestions without a draft at the run's draft changelog entry. */
  async setChangelogEntry(workspaceId: string, ids: readonly string[], entryId: string): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    await this.db
      .update(s)
      .set({ changelogEntryId: entryId })
      .where(and(eq(s.workspaceId, workspaceId), inArray(s.id, [...ids]), isNull(s.changelogEntryId)));
  }

  /** A board's suggestions waiting for the team, with their posts, the newest run first. */
  async pendingOnBoard(scope: FeedbackScope, boardId: string) {
    return await this.db
      .select({
        suggestion: s,
        post: {
          id: posts.id,
          number: posts.number,
          title: posts.title,
          status: posts.status,
          voteCount: posts.voteCount,
          mergedIntoPostId: posts.mergedIntoPostId,
        },
      })
      .from(s)
      .innerJoin(posts, and(eq(posts.id, s.postId), eq(posts.workspaceId, s.workspaceId)))
      .where(and(scoped(scope), eq(s.boardId, boardId), eq(s.state, ShipSuggestionStates.pending)))
      .orderBy(desc(s.createdAt), asc(posts.number));
  }

  /** Lock a board's suggestions from one run that still wait, in id order. */
  async lockPendingOfRun(scope: FeedbackScope, boardId: string, runId: string): Promise<ShipSuggestionRow[]> {
    return await this.db
      .select()
      .from(s)
      .where(and(scoped(scope), eq(s.boardId, boardId), eq(s.runId, runId), eq(s.state, ShipSuggestionStates.pending)))
      .orderBy(asc(s.id))
      .for('update');
  }

  /** Record the decision on these suggestions. */
  async decide(
    workspaceId: string,
    ids: readonly string[],
    decision: { state: Exclude<ShipSuggestionState, typeof ShipSuggestionStates.pending>; by: string | null; at: Date },
  ): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    await this.db
      .update(s)
      .set({ state: decision.state, decidedByUserId: decision.by, decidedAt: decision.at })
      .where(and(eq(s.workspaceId, workspaceId), inArray(s.id, [...ids])));
  }
}
