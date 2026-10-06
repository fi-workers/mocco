// Feedback board (#98, slice #172): a project's boards, their categories, and posts that staff
// move through statuses. Votes, comments, merges, GitHub links, the ship detector and the public
// `/v1` surface come in later slices; their constants land with them.
import { z } from 'zod';

/** Where a post is in its life. Staff may move a post from any status to any other. */
export const FeedbackPostStatuses = {
  underReview: 'under_review',
  planned: 'planned',
  inProgress: 'in_progress',
  shipped: 'shipped',
  closed: 'closed',
} as const;
export type FeedbackPostStatus = (typeof FeedbackPostStatuses)[keyof typeof FeedbackPostStatuses];
export const feedbackPostStatusSchema = z.enum(
  Object.values(FeedbackPostStatuses) as [FeedbackPostStatus, ...FeedbackPostStatus[]],
);

/** The order a board lists statuses in when sorted by status: the workflow, then closed. */
export const FEEDBACK_POST_STATUS_ORDER = [
  FeedbackPostStatuses.underReview,
  FeedbackPostStatuses.planned,
  FeedbackPostStatuses.inProgress,
  FeedbackPostStatuses.shipped,
  FeedbackPostStatuses.closed,
] as const satisfies readonly FeedbackPostStatus[];

/** The columns of a board's public roadmap. */
export const RoadmapColumns = [
  FeedbackPostStatuses.planned,
  FeedbackPostStatuses.inProgress,
  FeedbackPostStatuses.shipped,
] as const satisfies readonly FeedbackPostStatus[];
export type RoadmapColumn = (typeof RoadmapColumns)[number];

/** Why a post's status changed. Only `created` and `manual` are written so far; the ship
 * detector writes `ship_suggestion` and `auto_apply`, and merging writes `merge`. */
export const FeedbackStatusChangeReasons = {
  created: 'created',
  manual: 'manual',
  shipSuggestion: 'ship_suggestion',
  autoApply: 'auto_apply',
  merge: 'merge',
} as const;
export type FeedbackStatusChangeReason = (typeof FeedbackStatusChangeReasons)[keyof typeof FeedbackStatusChangeReasons];

/** How the staff list orders a board's posts. */
export const FeedbackPostSorts = {
  /** By status in workflow order, newest first within a status. */
  status: 'status',
  /** Newest first. */
  newest: 'newest',
} as const;
export type FeedbackPostSort = (typeof FeedbackPostSorts)[keyof typeof FeedbackPostSorts];
export const feedbackPostSortSchema = z.enum(
  Object.values(FeedbackPostSorts) as [FeedbackPostSort, ...FeedbackPostSort[]],
);

/** A url-safe board or category handle: lowercase alphanumerics and inner hyphens, 1–40 chars.
 * Mirrors the DB CHECKs on `mocco_feedback_boards.slug` and `mocco_feedback_categories.slug`. */
export const FEEDBACK_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export const FeedbackLimits = {
  nameMax: 80,
  titleMax: 200,
  bodyMax: 20_000,
  listMax: 100,
  listDefault: 50,
} as const;

const slug = z.string().regex(FEEDBACK_SLUG_PATTERN);
const name = z.string().trim().min(1).max(FeedbackLimits.nameMax);
const title = z.string().trim().min(1).max(FeedbackLimits.titleMax);
const body = z.string().trim().max(FeedbackLimits.bodyMax);

export const feedbackBoardInputSchema = z.object({ slug, name, isPublic: z.boolean().optional() });
export type FeedbackBoardInput = z.infer<typeof feedbackBoardInputSchema>;

export const feedbackCategoryInputSchema = z.object({ slug, name, position: z.int().min(0).optional() });
export type FeedbackCategoryInput = z.infer<typeof feedbackCategoryInputSchema>;

export const feedbackPostCreateInputSchema = z.object({
  boardId: z.uuid(),
  title,
  /** Defaults to empty. */
  body: body.optional(),
  categoryId: z.uuid().nullable().optional(),
  /** Defaults to under review. */
  status: feedbackPostStatusSchema.optional(),
});
export type FeedbackPostCreateInput = z.infer<typeof feedbackPostCreateInputSchema>;

/** A partial edit: only the given fields change; `categoryId: null` uncategorizes the post. */
export const feedbackPostUpdateInputSchema = z.object({
  title: title.optional(),
  body: body.optional(),
  categoryId: z.uuid().nullable().optional(),
});
export type FeedbackPostUpdateInput = z.infer<typeof feedbackPostUpdateInputSchema>;

export const feedbackPostListInputSchema = z.object({
  boardId: z.uuid(),
  status: feedbackPostStatusSchema.optional(),
  categoryId: z.uuid().optional(),
  sort: feedbackPostSortSchema.default(FeedbackPostSorts.status),
  limit: z.int().min(1).max(FeedbackLimits.listMax).default(FeedbackLimits.listDefault),
  offset: z.int().min(0).default(0),
});
export type FeedbackPostListInput = z.input<typeof feedbackPostListInputSchema>;
export type FeedbackPostListQuery = z.output<typeof feedbackPostListInputSchema>;
