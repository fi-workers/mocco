// The /v1/feedback wire shapes (#174): what an app or a public board reads from a project's
// feedback boards with a feedback:read key, and what its signed-in end users send with a
// feedback:write key and their end-user token. The routes parse every answer through these,
// so a field missing here (a team member's id, an internal note, an email) can never reach
// the wire.
import { z } from 'zod';

import {
  FEEDBACK_SLUG_PATTERN,
  FeedbackCommentAuthorKinds,
  FeedbackLimits,
  FeedbackVoteSources,
  FeedbackVoteStates,
  feedbackPostStatusSchema,
  RoadmapColumns,
} from '@mocco/common/feedback';

import type { FeedbackCommentAuthorKind, FeedbackVoteState } from '@mocco/common/feedback';

/** How the public list orders a board's posts. */
export const FeedbackPublicSorts = {
  /** Most counted votes first, newest first among equals. */
  top: 'top',
  /** Newest first. */
  new: 'new',
} as const;
export type FeedbackPublicSort = (typeof FeedbackPublicSorts)[keyof typeof FeedbackPublicSorts];

const timestamp = z.iso.datetime();
const page = {
  limit: z.coerce.number().int().min(1).max(FeedbackLimits.listMax).default(FeedbackLimits.listDefault),
  offset: z.coerce.number().int().min(0).default(0),
};

export const feedbackV1SlugSchema = z.string().regex(FEEDBACK_SLUG_PATTERN);

/** `GET /boards/{slug}/posts` query: filter by status and by category slug. */
export const feedbackV1PostListQuerySchema = z.object({
  status: feedbackPostStatusSchema.optional(),
  category: feedbackV1SlugSchema.optional(),
  sort: z.enum([FeedbackPublicSorts.top, FeedbackPublicSorts.new]).default(FeedbackPublicSorts.top),
  ...page,
});

export const feedbackV1PageQuerySchema = z.object(page);

export const feedbackV1CategorySchema = z.object({ id: z.uuid(), slug: z.string(), name: z.string() });

export const feedbackV1BoardSchema = z.object({
  board: z.object({ slug: z.string(), name: z.string(), categories: z.array(feedbackV1CategorySchema) }),
});

/** A post as the public sees it. `mergedIntoPostId` is set on a duplicate: show that post instead. */
export const feedbackV1PostSchema = z.object({
  id: z.uuid(),
  number: z.int(),
  title: z.string(),
  body: z.string(),
  status: feedbackPostStatusSchema,
  categoryId: z.uuid().nullable(),
  voteCount: z.int(),
  commentCount: z.int(),
  createdAt: timestamp,
  shippedAt: timestamp.nullable(),
  mergedIntoPostId: z.uuid().nullable(),
});
export type FeedbackV1Post = z.infer<typeof feedbackV1PostSchema>;

export const feedbackV1PostListSchema = z.object({
  posts: z.array(feedbackV1PostSchema),
  /** The offset of the next page, or null on the last. */
  nextOffset: z.int().nullable(),
});

export const feedbackV1RoadmapSchema = z.object({
  roadmap: z.object(
    Object.fromEntries(RoadmapColumns.map(column => [column, z.array(feedbackV1PostSchema)])) as Record<
      (typeof RoadmapColumns)[number],
      z.ZodArray<typeof feedbackV1PostSchema>
    >,
  ),
});

const voteState = z.enum([FeedbackVoteStates.pending, FeedbackVoteStates.counted] as [
  FeedbackVoteState,
  ...FeedbackVoteState[],
]);

/** One post; `viewer` answers for the end user whose token came with the request (null without one). */
export const feedbackV1PostDetailSchema = z.object({
  post: feedbackV1PostSchema,
  viewer: z.object({ vote: voteState.nullable() }).nullable(),
});

/** A comment as the public sees it: never an internal note, never who on the team wrote it,
 * never another end user's id; `isMine` marks the viewer's own. */
export const feedbackV1CommentSchema = z.object({
  id: z.uuid(),
  authorKind: z.enum([FeedbackCommentAuthorKinds.staff, FeedbackCommentAuthorKinds.endUser] as [
    FeedbackCommentAuthorKind,
    ...FeedbackCommentAuthorKind[],
  ]),
  isOfficial: z.boolean(),
  isMine: z.boolean(),
  body: z.string(),
  createdAt: timestamp,
});

export const feedbackV1CommentListSchema = z.object({
  comments: z.array(feedbackV1CommentSchema),
  nextOffset: z.int().nullable(),
});

/** `POST /posts/{id}/vote`: where the vote came from (the in-app widget by default). */
export const feedbackV1VoteInputSchema = z.object({
  source: z.enum([FeedbackVoteSources.web, FeedbackVoteSources.widget]).default(FeedbackVoteSources.widget),
});

export const feedbackV1VoteResultSchema = z.object({
  vote: voteState.nullable(),
  voteCount: z.int(),
});

export const feedbackV1CommentInputSchema = z.object({
  body: z.string().trim().min(1).max(FeedbackLimits.commentMax),
});

export const feedbackV1CommentResultSchema = z.object({ comment: feedbackV1CommentSchema });

/** `POST /boards/{slug}/posts`: a signed-in end user's post. It starts under review with the
 * author's vote. */
export const feedbackV1PostCreateInputSchema = z.object({
  title: z.string().trim().min(1).max(FeedbackLimits.titleMax),
  body: z.string().trim().max(FeedbackLimits.bodyMax).optional(),
  categoryId: z.uuid().optional(),
});

export const feedbackV1PostResultSchema = z.object({ post: feedbackV1PostSchema });

/** How many posts `GET /boards/{slug}/similar` returns at most. */
export const FEEDBACK_SIMILAR_MAX = 10;

/** `GET /boards/{slug}/similar`: posts like a title being typed, so the end user can vote instead. */
export const feedbackV1SimilarQuerySchema = z.object({
  q: z.string().trim().min(1).max(FeedbackLimits.titleMax),
  limit: z.coerce.number().int().min(1).max(FEEDBACK_SIMILAR_MAX).default(5),
});

export const feedbackV1SimilarSchema = z.object({ posts: z.array(feedbackV1PostSchema) });

export const feedbackV1SubscriptionResultSchema = z.object({ subscribed: z.boolean() });

/** The longest address `POST /identify/email` takes: its end-user id (`email:` + the address)
 * must fit the 255-character end-user id. */
export const FEEDBACK_EMAIL_MAX = 249;

/** `POST /identify/email`: vote by email. The vote waits as pending until the address confirms. */
export const feedbackV1IdentifyEmailInputSchema = z.object({
  email: z.email().max(FEEDBACK_EMAIL_MAX),
  postId: z.uuid(),
  source: z.enum([FeedbackVoteSources.web, FeedbackVoteSources.widget]).default(FeedbackVoteSources.web),
});

export const FeedbackIdentifyStatuses = { pendingConfirmation: 'pending_confirmation' } as const;

export const feedbackV1IdentifyEmailResultSchema = z.object({
  status: z.literal(FeedbackIdentifyStatuses.pendingConfirmation),
});
