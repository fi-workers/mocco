// End users following feedback posts (#173), to be told when one moves (the notification fan-out
// comes with the ship detector). Voting subscribes (VoteService); an end user can also follow or
// stop following a post. Stopping keeps the row as an opt-out, so voting later doesn't resubscribe.
import { lockLivePost } from '@backend/domain/feedback/live-post';
import { FeedbackSubscriptionRepo } from '@backend/domain/feedback/repos/subscription.repo';

import type { PostService } from '@backend/domain/feedback/PostService';
import type { FeedbackSubscriptionRow } from '@backend/domain/feedback/repos/subscription.repo';
import type { FeedbackScope } from '@backend/domain/feedback/scope';
import type { Db } from '@backend/infra/db/types';
import type { FeedbackPage } from '@mocco/common/feedback';

export interface SubscriptionServiceDeps {
  db: Db;
  posts: Pick<PostService, 'requirePost'>;
  now?: () => Date;
}

export class SubscriptionService {
  constructor(private readonly deps: SubscriptionServiceDeps) {}

  /** Follow the post, clearing an earlier opt-out. Idempotent. */
  async subscribe(scope: FeedbackScope, postId: string, endUserId: string): Promise<FeedbackSubscriptionRow> {
    return await this.deps.db.transaction(async tx => {
      await lockLivePost(tx, scope, postId);
      return await new FeedbackSubscriptionRepo(tx).subscribe(scope.workspaceId, postId, endUserId);
    });
  }

  /** Stop following the post; the opt-out outlives later votes. Idempotent. */
  async unsubscribe(scope: FeedbackScope, postId: string, endUserId: string): Promise<FeedbackSubscriptionRow> {
    return await this.deps.db.transaction(async tx => {
      await lockLivePost(tx, scope, postId);
      return await new FeedbackSubscriptionRepo(tx).unsubscribe(
        scope.workspaceId,
        postId,
        endUserId,
        this.deps.now?.() ?? new Date(),
      );
    });
  }

  /** The post's current subscribers, oldest first. */
  async list(scope: FeedbackScope, postId: string, page: FeedbackPage): Promise<FeedbackSubscriptionRow[]> {
    await this.deps.posts.requirePost(scope, postId);
    return await new FeedbackSubscriptionRepo(this.deps.db).listActive(scope.workspaceId, postId, page);
  }
}
