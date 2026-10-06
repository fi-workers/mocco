// The feedback domain's services over a db (#172, #173, #174). Pure (no instance imports); instance.ts
// binds the production deps, tests bind pglite.
import { BoardService } from '@backend/domain/feedback/BoardService';
import { CommentService } from '@backend/domain/feedback/CommentService';
import { EmailVoteService } from '@backend/domain/feedback/EmailVoteService';
import { MergeService } from '@backend/domain/feedback/MergeService';
import { PostService } from '@backend/domain/feedback/PostService';
import { PublicBoardService } from '@backend/domain/feedback/PublicBoardService';
import { SubscriptionService } from '@backend/domain/feedback/SubscriptionService';
import { VoteService } from '@backend/domain/feedback/VoteService';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type { FeedbackLinkEnvDeps } from '@backend/domain/feedback/link-config';
import type { Db } from '@backend/infra/db/types';

export interface FeedbackDomain {
  feedbackBoards: BoardService;
  feedbackPosts: PostService;
  feedbackVotes: VoteService;
  feedbackComments: CommentService;
  feedbackSubscriptions: SubscriptionService;
  feedbackMerges: MergeService;
  /** What /v1/feedback serves (#174). */
  feedbackPublic: PublicBoardService;
  /** Voting by email and the signed mail links (#174); undefined without a link signing key. */
  feedbackEmailVotes: EmailVoteService | undefined;
}

export function createFeedbackDomain(
  db: Db,
  deps: {
    audit: Pick<AuditService, 'record'>;
    now?: () => Date;
    /** The mail links' key and sender, and the origin their URLs start with. */
    links?: FeedbackLinkEnvDeps & { appOrigin: string };
  },
): FeedbackDomain {
  const now = deps.now === undefined ? {} : { now: deps.now };
  const feedbackBoards = new BoardService({ db, audit: deps.audit });
  const feedbackPosts = new PostService({ db, audit: deps.audit, boards: feedbackBoards, ...now });
  const feedbackVotes = new VoteService({ db, posts: feedbackPosts, ...now });
  const feedbackComments = new CommentService({ db, posts: feedbackPosts });
  const feedbackSubscriptions = new SubscriptionService({ db, posts: feedbackPosts, ...now });
  const feedbackPublic = new PublicBoardService({
    db,
    votes: feedbackVotes,
    comments: feedbackComments,
    posts: feedbackPosts,
    subscriptions: feedbackSubscriptions,
  });
  return {
    feedbackBoards,
    feedbackPosts,
    feedbackVotes,
    feedbackComments,
    feedbackSubscriptions,
    feedbackMerges: new MergeService({ db, audit: deps.audit, ...now }),
    feedbackPublic,
    feedbackEmailVotes:
      deps.links === undefined
        ? undefined
        : new EmailVoteService({ db, boards: feedbackPublic, votes: feedbackVotes, ...deps.links, ...now }),
  };
}
