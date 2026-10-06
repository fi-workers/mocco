// The lock every end-user write to a post takes first (votes, subscriptions): the post's row,
// which MergeService also locks, so a vote or subscription can't land on a post while its votes
// and subscribers are being moved. A merged post takes no more of either.
import { FeedbackPostMergedError, FeedbackPostNotFoundError } from '@backend/domain/feedback/errors';
import { FeedbackPostRepo } from '@backend/domain/feedback/repos/post.repo';

import type { FeedbackPostRow } from '@backend/domain/feedback/repos/post.repo';
import type { FeedbackScope } from '@backend/domain/feedback/scope';
import type { Db } from '@backend/infra/db/types';

/** The post, locked until `tx` ends; FeedbackPostNotFoundError outside the scope,
 * FeedbackPostMergedError once it was merged. */
export async function lockLivePost(tx: Db, scope: FeedbackScope, postId: string): Promise<FeedbackPostRow> {
  const post = await new FeedbackPostRepo(tx).findForUpdate(scope, postId);
  if (post === undefined) {
    throw new FeedbackPostNotFoundError(postId);
  }
  if (post.mergedIntoPostId !== null) {
    throw new FeedbackPostMergedError(postId, post.mergedIntoPostId);
  }
  return post;
}
