// End users' votes on feedback posts (#173). One vote per (post, end user): voting again is a
// no-op, and a post's `vote_count` moves only in the transaction that counts or removes a vote,
// so it always equals the post's counted votes. Every write locks the post row first, so writes
// to one post apply one after another in the same lock order.
import { FeedbackVoteStates } from '@mocco/common/feedback';

import { FeedbackPostNotFoundError, FeedbackVoteNotFoundError } from '@backend/domain/feedback/errors';
import { FeedbackPostRepo } from '@backend/domain/feedback/repos/post.repo';
import { FeedbackVoteRepo } from '@backend/domain/feedback/repos/vote.repo';

import type { PostService } from '@backend/domain/feedback/PostService';
import type { FeedbackPostRow } from '@backend/domain/feedback/repos/post.repo';
import type { FeedbackVoteRow } from '@backend/domain/feedback/repos/vote.repo';
import type { FeedbackScope } from '@backend/domain/feedback/scope';
import type { Db } from '@backend/infra/db/types';
import type { FeedbackPage, FeedbackVoteSource, FeedbackVoteState } from '@mocco/common/feedback';

export interface VoteServiceDeps {
  db: Db;
  posts: Pick<PostService, 'requirePost'>;
  now?: () => Date;
}

export interface VoteOptions {
  source: FeedbackVoteSource;
  /** `counted` (the default) for an identified end user; `pending` until an email-only voter confirms. */
  state?: FeedbackVoteState;
  /** The team member recording the vote on the end user's behalf. */
  recordedByUserId?: string;
}

export interface VoteResult {
  vote: FeedbackVoteRow;
  post: FeedbackPostRow;
}

export class VoteService {
  constructor(private readonly deps: VoteServiceDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Run `write` with the post locked; another project's post is FeedbackPostNotFoundError. */
  private async withPostLocked<T>(
    scope: FeedbackScope,
    postId: string,
    write: (tx: Db, post: FeedbackPostRow) => Promise<T>,
  ): Promise<T> {
    return await this.deps.db.transaction(async tx => {
      const post = await new FeedbackPostRepo(tx).findForUpdate(scope, postId);
      if (post === undefined) {
        throw new FeedbackPostNotFoundError(postId);
      }
      return await write(tx, post);
    });
  }

  /**
   * The end user's vote on the post. Idempotent: a second vote returns the first, except that a
   * counted vote over a pending one counts it (the voter identified themselves since).
   */
  async vote(scope: FeedbackScope, postId: string, endUserId: string, options: VoteOptions): Promise<VoteResult> {
    const state = options.state ?? FeedbackVoteStates.counted;
    const isCounted = state === FeedbackVoteStates.counted;
    return await this.withPostLocked(scope, postId, async (tx, post) => {
      const votes = new FeedbackVoteRepo(tx);
      const inserted = await votes.insertIfAbsent({
        workspaceId: scope.workspaceId,
        postId,
        endUserId,
        state,
        source: options.source,
        recordedByUserId: options.recordedByUserId ?? null,
        countedAt: isCounted ? this.now() : null,
      });
      if (inserted !== undefined) {
        return {
          vote: inserted,
          post: isCounted ? await new FeedbackPostRepo(tx).addToCount(scope, postId, 'voteCount', 1) : post,
        };
      }
      const counted = isCounted ? await votes.markCounted(scope.workspaceId, postId, endUserId, this.now()) : undefined;
      if (counted !== undefined) {
        return { vote: counted, post: await new FeedbackPostRepo(tx).addToCount(scope, postId, 'voteCount', 1) };
      }
      const existing = await votes.find(scope.workspaceId, postId, endUserId);
      if (existing === undefined) {
        // The post is locked, so the conflicting vote can't have gone since the insert.
        throw new FeedbackVoteNotFoundError(postId);
      }
      return { vote: existing, post };
    });
  }

  /** Count the end user's pending vote (they confirmed their email). A counted vote stays as it is. */
  async confirm(scope: FeedbackScope, postId: string, endUserId: string): Promise<VoteResult> {
    return await this.withPostLocked(scope, postId, async (tx, post) => {
      const votes = new FeedbackVoteRepo(tx);
      const counted = await votes.markCounted(scope.workspaceId, postId, endUserId, this.now());
      if (counted !== undefined) {
        return { vote: counted, post: await new FeedbackPostRepo(tx).addToCount(scope, postId, 'voteCount', 1) };
      }
      const existing = await votes.find(scope.workspaceId, postId, endUserId);
      if (existing === undefined) {
        throw new FeedbackVoteNotFoundError(postId);
      }
      return { vote: existing, post };
    });
  }

  /** Take the end user's vote back. Idempotent: no vote is no change. Returns the post. */
  async unvote(scope: FeedbackScope, postId: string, endUserId: string): Promise<FeedbackPostRow> {
    return await this.withPostLocked(scope, postId, async (tx, post) => {
      const removed = await new FeedbackVoteRepo(tx).delete(scope.workspaceId, postId, endUserId);
      return removed?.state === FeedbackVoteStates.counted
        ? await new FeedbackPostRepo(tx).addToCount(scope, postId, 'voteCount', -1)
        : post;
    });
  }

  /** The post's votes, newest first, pending ones included. */
  async list(scope: FeedbackScope, postId: string, page: FeedbackPage): Promise<FeedbackVoteRow[]> {
    await this.deps.posts.requirePost(scope, postId);
    return await new FeedbackVoteRepo(this.deps.db).listForPost(scope.workspaceId, postId, page);
  }
}
