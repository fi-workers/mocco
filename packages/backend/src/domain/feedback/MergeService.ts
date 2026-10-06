// Merging duplicate feedback posts (#173). Merging A into B copies A's votes and subscribers to
// B, one per end user (someone who voted on both still counts once), recounts B's votes, points
// the posts already merged into A at B (no chains), and closes A with a `merge` history row. A
// keeps its own votes, comments and history, so what it had stays readable. All of it is one
// transaction under the `feedbackPost` advisory lock and both posts' row locks, taken in id order.
import { AuditActions } from '@mocco/common/audit';
import { FeedbackPostStatuses, FeedbackStatusChangeReasons } from '@mocco/common/feedback';

import {
  FeedbackMergeInvalidError,
  FeedbackPostMergedError,
  FeedbackPostNotFoundError,
} from '@backend/domain/feedback/errors';
import { FeedbackPostRepo } from '@backend/domain/feedback/repos/post.repo';
import { FeedbackStatusChangeRepo } from '@backend/domain/feedback/repos/status-change.repo';
import { FeedbackSubscriptionRepo } from '@backend/domain/feedback/repos/subscription.repo';
import { FeedbackVoteRepo } from '@backend/domain/feedback/repos/vote.repo';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type { FeedbackPostRow } from '@backend/domain/feedback/repos/post.repo';
import type { FeedbackScope } from '@backend/domain/feedback/scope';
import type { Db } from '@backend/infra/db/types';

export interface MergeServiceDeps {
  db: Db;
  audit: Pick<AuditService, 'record'>;
  now?: () => Date;
}

export interface MergeResult {
  /** The duplicate, now merged and closed. */
  source: FeedbackPostRow;
  /** The post it was merged into, with its recounted votes. */
  target: FeedbackPostRow;
}

export class MergeService {
  constructor(private readonly deps: MergeServiceDeps) {}

  /**
   * Merge `sourceId` into `targetId`, both on one board of the scope. A merged post can't be
   * merged again or merged into (FeedbackPostMergedError); a post into itself or across boards
   * is FeedbackMergeInvalidError.
   */
  async merge(scope: FeedbackScope, actorUserId: string, sourceId: string, targetId: string): Promise<MergeResult> {
    if (sourceId === targetId) {
      throw new FeedbackMergeInvalidError('same_post');
    }
    const now = this.deps.now?.() ?? new Date();
    const result = await this.deps.db.transaction(async tx => {
      const posts = new FeedbackPostRepo(tx);
      const locked = await posts.lockForMerge(scope, [sourceId, targetId]);
      const live = (id: string): FeedbackPostRow => {
        const post = locked.get(id);
        if (post === undefined) {
          throw new FeedbackPostNotFoundError(id);
        }
        if (post.mergedIntoPostId !== null) {
          throw new FeedbackPostMergedError(id, post.mergedIntoPostId);
        }
        return post;
      };
      const source = live(sourceId);
      const target = live(targetId);
      if (source.boardId !== target.boardId) {
        throw new FeedbackMergeInvalidError('other_board');
      }

      const votes = new FeedbackVoteRepo(tx);
      await votes.copyToPost(scope.workspaceId, sourceId, targetId);
      await new FeedbackSubscriptionRepo(tx).copyToPost(scope.workspaceId, sourceId, targetId);
      await posts.reparentMerged(scope, sourceId, targetId);
      const merged = await posts.markMerged(scope, sourceId, {
        intoPostId: targetId,
        at: now,
        status: FeedbackPostStatuses.closed,
      });
      if (source.status !== FeedbackPostStatuses.closed) {
        await new FeedbackStatusChangeRepo(tx).append({
          workspaceId: scope.workspaceId,
          postId: sourceId,
          fromStatus: source.status,
          toStatus: FeedbackPostStatuses.closed,
          reason: FeedbackStatusChangeReasons.merge,
          actorUserId,
        });
      }
      const recounted = await posts.setVoteCount(
        scope,
        targetId,
        await votes.countCounted(scope.workspaceId, targetId),
      );
      return { source: merged, target: recounted, before: target.voteCount };
    });
    await this.deps.audit.record(scope.workspaceId, {
      actorUserId,
      action: AuditActions.feedbackPostMerged,
      subjectType: 'feedback_post',
      subjectId: sourceId,
      payload: {
        projectId: scope.projectId,
        boardId: result.source.boardId,
        number: result.source.number,
        intoPostId: targetId,
        intoNumber: result.target.number,
        votesAdded: result.target.voteCount - result.before,
      },
    });
    return { source: result.source, target: result.target };
  }
}
