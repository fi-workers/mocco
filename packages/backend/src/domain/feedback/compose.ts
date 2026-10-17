// The feedback domain's services over a db (#172, #173, #174). Pure (no instance imports); instance.ts
// binds the production deps, tests bind pglite.
import { BoardService } from '@backend/domain/feedback/BoardService';
import { ChangelogService } from '@backend/domain/feedback/ChangelogService';
import { CommentService } from '@backend/domain/feedback/CommentService';
import { DuplicateService } from '@backend/domain/feedback/DuplicateService';
import { EmailVoteService } from '@backend/domain/feedback/EmailVoteService';
import { IntakeService } from '@backend/domain/feedback/IntakeService';
import { LinkService } from '@backend/domain/feedback/LinkService';
import { MergeService } from '@backend/domain/feedback/MergeService';
import { PostService } from '@backend/domain/feedback/PostService';
import { PublicBoardService } from '@backend/domain/feedback/PublicBoardService';
import { SubscriptionService } from '@backend/domain/feedback/SubscriptionService';
import { VoteService } from '@backend/domain/feedback/VoteService';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type { FeedbackSourceReaders } from '@backend/domain/feedback/IntakeService';
import type { FeedbackLinkEnvDeps } from '@backend/domain/feedback/link-config';
import type { IssueTracker } from '@backend/domain/integration/ports';
import type { Db } from '@backend/infra/db/types';

export interface FeedbackDomain {
  feedbackBoards: BoardService;
  feedbackPosts: PostService;
  feedbackVotes: VoteService;
  feedbackComments: CommentService;
  feedbackSubscriptions: SubscriptionService;
  feedbackMerges: MergeService;
  /** Suggested duplicate pairs for staff (#181). */
  feedbackDuplicates: DuplicateService;
  /** Requests from other products turned into posts (#182). */
  feedbackIntake: IntakeService;
  /** A board's changelog entries (#176). */
  feedbackChangelog: ChangelogService;
  /** GitHub issues and pull requests linked to posts (#178). */
  feedbackLinks: LinkService;
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
    /** Other products' sources a post can come from (#182); none, and nothing converts. */
    sources?: FeedbackSourceReaders;
    /** The mail links' key and sender, and the origin their URLs start with. */
    links?: FeedbackLinkEnvDeps & { appOrigin: string };
    /** Reads GitHub issues and pull requests (#178); none, and posts can't be linked. */
    tracker?: IssueTracker;
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
    ...now,
  });
  return {
    feedbackBoards,
    feedbackPosts,
    feedbackVotes,
    feedbackComments,
    feedbackSubscriptions,
    feedbackMerges: new MergeService({ db, audit: deps.audit, ...now }),
    feedbackDuplicates: new DuplicateService({ db, audit: deps.audit, boards: feedbackBoards, ...now }),
    feedbackIntake: new IntakeService({
      db,
      audit: deps.audit,
      boards: feedbackBoards,
      posts: feedbackPosts,
      votes: feedbackVotes,
      sources: deps.sources ?? {},
    }),
    feedbackChangelog: new ChangelogService({ db, audit: deps.audit, boards: feedbackBoards, ...now }),
    feedbackLinks: new LinkService({
      db,
      audit: deps.audit,
      posts: feedbackPosts,
      ...(deps.tracker !== undefined && { tracker: deps.tracker }),
      ...now,
    }),
    feedbackPublic,
    feedbackEmailVotes:
      deps.links === undefined
        ? undefined
        : new EmailVoteService({ db, boards: feedbackPublic, votes: feedbackVotes, ...deps.links, ...now }),
  };
}
