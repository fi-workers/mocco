// The feedback domain's services over a db (#172, #173). Pure (no instance imports); instance.ts
// binds the production deps, tests bind pglite.
import { BoardService } from '@backend/domain/feedback/BoardService';
import { CommentService } from '@backend/domain/feedback/CommentService';
import { MergeService } from '@backend/domain/feedback/MergeService';
import { PostService } from '@backend/domain/feedback/PostService';
import { SubscriptionService } from '@backend/domain/feedback/SubscriptionService';
import { VoteService } from '@backend/domain/feedback/VoteService';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type { Db } from '@backend/infra/db/types';

export interface FeedbackDomain {
  feedbackBoards: BoardService;
  feedbackPosts: PostService;
  feedbackVotes: VoteService;
  feedbackComments: CommentService;
  feedbackSubscriptions: SubscriptionService;
  feedbackMerges: MergeService;
}

export function createFeedbackDomain(
  db: Db,
  deps: { audit: Pick<AuditService, 'record'>; now?: () => Date },
): FeedbackDomain {
  const now = deps.now === undefined ? {} : { now: deps.now };
  const feedbackBoards = new BoardService({ db, audit: deps.audit });
  const feedbackPosts = new PostService({ db, audit: deps.audit, boards: feedbackBoards, ...now });
  return {
    feedbackBoards,
    feedbackPosts,
    feedbackVotes: new VoteService({ db, posts: feedbackPosts, ...now }),
    feedbackComments: new CommentService({ db, posts: feedbackPosts }),
    feedbackSubscriptions: new SubscriptionService({ db, posts: feedbackPosts, ...now }),
    feedbackMerges: new MergeService({ db, audit: deps.audit, ...now }),
  };
}
