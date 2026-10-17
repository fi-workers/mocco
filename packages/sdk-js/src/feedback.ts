// `@mocco/js/feedback` (#177): a project's feedback boards from the page. Read a board's posts
// and changelog with a publishable key (feedback:read); vote, post ideas, comment and follow as
// the signed-in user with the token your server signs (feedback:write). The "what's new" badge
// is `@mocco/js/whats-new`, and a ready-made sheet of ideas is `@mocco/js/feedback-sheet`.
import { FeedbackClient } from '@mocco/sdk-core/feedback';

import type { FeedbackClientOptions } from '@mocco/sdk-core/feedback';

/** The feedback client for the page; create it once (it keeps the end user's token). */
export function createFeedback(options: FeedbackClientOptions): FeedbackClient {
  return new FeedbackClient(options);
}

export { FeedbackClient } from '@mocco/sdk-core/feedback';
export type {
  EndUserTokenSource,
  FeedbackBoard,
  FeedbackBoardClient,
  FeedbackCategory,
  FeedbackChangelogEntry,
  FeedbackChangelogPage,
  FeedbackChangelogPost,
  FeedbackChangelogSeen,
  FeedbackChangelogTag,
  FeedbackChangelogUnread,
  FeedbackClientOptions,
  FeedbackComment,
  FeedbackCommentPage,
  FeedbackPageOptions,
  FeedbackPost,
  FeedbackPostCreateRequest,
  FeedbackPostDetail,
  FeedbackPostListOptions,
  FeedbackPostPage,
  FeedbackPostStatus,
  FeedbackRoadmap,
  FeedbackSubscription,
  FeedbackVoteResult,
  FeedbackVoteState,
} from '@mocco/sdk-core/feedback';
