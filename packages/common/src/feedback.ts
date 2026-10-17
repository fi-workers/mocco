// Feedback board (#98): a project's boards, their categories, and posts that staff move through
// statuses (#172), with votes and comments (#173). Subscriptions, merges, GitHub links, the ship
// detector and the public `/v1` surface come in later slices; their constants land with them.
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

/** Why a post's status changed: `created` and `manual` by the team, `ship_suggestion` when the
 * team accepts a ship suggestion, `auto_apply` when a board ships it without asking (#179), and
 * `merge` when a duplicate is merged. */
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
  /** Most counted votes first, newest first among equals. */
  top: 'top',
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
  commentMax: 8000,
  endUserIdMax: 255,
  listMax: 100,
  listDefault: 50,
} as const;

/** Whether a vote counts yet. An identified end user's vote counts at once; an email-only
 * voter's waits as `pending` until they confirm the address. `vote_count` counts only `counted`. */
export const FeedbackVoteStates = { pending: 'pending', counted: 'counted' } as const;
export type FeedbackVoteState = (typeof FeedbackVoteStates)[keyof typeof FeedbackVoteStates];

/** Where a vote came from: the public board, the in-app widget, a team member recording it on
 * the end user's behalf, a conversion from another product, or a merge of duplicates. */
export const FeedbackVoteSources = {
  web: 'web',
  widget: 'widget',
  staff: 'staff',
  intake: 'intake',
  merge: 'merge',
} as const;
export type FeedbackVoteSource = (typeof FeedbackVoteSources)[keyof typeof FeedbackVoteSources];

/** Who wrote a comment: a team member, or an end user of the project's app. */
export const FeedbackCommentAuthorKinds = { staff: 'staff', endUser: 'end_user' } as const;
export type FeedbackCommentAuthorKind = (typeof FeedbackCommentAuthorKinds)[keyof typeof FeedbackCommentAuthorKinds];

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

/** An end user as the project's app knows them: the user id the app signs, the same id space as
 * a messenger contact's. End-user identity (#100) gives these ids a directory; until then a vote,
 * a comment and a subscription carry the id itself. */
/** An email-only voter's end-user id is this prefix and the address, lowercased. Signed-in end
 * users can't take ids in this space (the /v1 transport refuses a token whose `sub` starts with it). */
export const FEEDBACK_EMAIL_END_USER_PREFIX = 'email:';

export const feedbackEndUserIdSchema = z.string().trim().min(1).max(FeedbackLimits.endUserIdMax);

export const feedbackPageInputSchema = z.object({
  limit: z.int().min(1).max(FeedbackLimits.listMax).default(FeedbackLimits.listDefault),
  offset: z.int().min(0).default(0),
});
export type FeedbackPage = z.output<typeof feedbackPageInputSchema>;

/** A team member's comment. `isOfficial` marks the team's response to the post; `isInternal`
 * keeps it to the team. A comment can't be both (`CommentService` refuses it, a DB check holds it). */
export const feedbackCommentInputSchema = z.object({
  body: z.string().trim().min(1).max(FeedbackLimits.commentMax),
  isOfficial: z.boolean().default(false),
  isInternal: z.boolean().default(false),
});
export type FeedbackCommentInput = z.output<typeof feedbackCommentInputSchema>;

// ─── Changelog (#176) ────────────────────────────────────────────────────────

/** Where a changelog entry is: being written, waiting for its publish time, or public. */
export const ChangelogEntryStates = { draft: 'draft', scheduled: 'scheduled', published: 'published' } as const;
export type ChangelogEntryState = (typeof ChangelogEntryStates)[keyof typeof ChangelogEntryStates];
export const changelogEntryStateSchema = z.enum(
  Object.values(ChangelogEntryStates) as [ChangelogEntryState, ...ChangelogEntryState[]],
);

/** What kind of change an entry announces; an entry has any of them. */
export const ChangelogTags = { new: 'new', improved: 'improved', fixed: 'fixed' } as const;
export type ChangelogTag = (typeof ChangelogTags)[keyof typeof ChangelogTags];
export const changelogTagSchema = z.enum(Object.values(ChangelogTags) as [ChangelogTag, ...ChangelogTag[]]);

export const ChangelogLimits = {
  titleMax: 200,
  bodyMax: 50_000,
  /** How many posts one entry can announce. */
  postsMax: 50,
} as const;

/** A url-safe entry address within its board: lowercase alphanumerics and inner hyphens, 1–80
 * chars. Mirrors the DB CHECK on `mocco_changelog_entries.slug`. */
export const CHANGELOG_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;

const changelogTitle = z.string().trim().min(1).max(ChangelogLimits.titleMax);
const changelogBody = z.string().trim().max(ChangelogLimits.bodyMax);
const changelogTags = z.array(changelogTagSchema).max(Object.keys(ChangelogTags).length);
const changelogPostIds = z.array(z.uuid()).max(ChangelogLimits.postsMax);

/** A new draft. The slug defaults to one made from the title (made unique on the board). */
export const changelogEntryCreateInputSchema = z.object({
  boardId: z.uuid(),
  title: changelogTitle,
  body: changelogBody.optional(),
  slug: z.string().regex(CHANGELOG_SLUG_PATTERN).optional(),
  tags: changelogTags.optional(),
  /** The board's posts this entry announces. */
  postIds: changelogPostIds.optional(),
});
export type ChangelogEntryCreateInput = z.infer<typeof changelogEntryCreateInputSchema>;

/** A partial edit, in any state: only the given fields change; `postIds` and `tags` replace the lists. */
export const changelogEntryUpdateInputSchema = z.object({
  title: changelogTitle.optional(),
  body: changelogBody.optional(),
  slug: z.string().regex(CHANGELOG_SLUG_PATTERN).optional(),
  tags: changelogTags.optional(),
  postIds: changelogPostIds.optional(),
});
export type ChangelogEntryUpdateInput = z.infer<typeof changelogEntryUpdateInputSchema>;

export const changelogEntryListInputSchema = z.object({
  boardId: z.uuid(),
  state: changelogEntryStateSchema.optional(),
  limit: z.int().min(1).max(FeedbackLimits.listMax).default(FeedbackLimits.listDefault),
  offset: z.int().min(0).default(0),
});
export type ChangelogEntryListQuery = z.output<typeof changelogEntryListInputSchema>;

// ─── Status mail (#180) ──────────────────────────────────────────────────────

/** Where one status-change mail to one end user is. A mail is sent at most once: it is claimed
 * (`sending`) before it goes out; `skipped` means the end user stopped following first. */
export const FeedbackStatusMailStates = {
  queued: 'queued',
  sending: 'sending',
  sent: 'sent',
  failed: 'failed',
  skipped: 'skipped',
} as const;
export type FeedbackStatusMailState = (typeof FeedbackStatusMailStates)[keyof typeof FeedbackStatusMailStates];

/** The statuses a post's followers hear about; moving back to under review mails no one. */
export const FEEDBACK_NOTIFIED_STATUSES = [
  FeedbackPostStatuses.planned,
  FeedbackPostStatuses.inProgress,
  FeedbackPostStatuses.shipped,
  FeedbackPostStatuses.closed,
] as const satisfies readonly FeedbackPostStatus[];

// ─── Duplicates (#181) ───────────────────────────────────────────────────────

/** A suggested duplicate pair, for staff: still to decide, or set aside as not a duplicate (it
 * never comes back). Merging the pair takes it out of the queue: a merged post is in no pair. */
export const FeedbackDuplicateStates = { open: 'open', dismissed: 'dismissed' } as const;
export type FeedbackDuplicateState = (typeof FeedbackDuplicateStates)[keyof typeof FeedbackDuplicateStates];

/** How a pair was found: shared title words, or close meaning by the posts' embeddings (#181). */
export const FeedbackDuplicateMethods = { fulltext: 'fulltext', embedding: 'embedding' } as const;
export type FeedbackDuplicateMethod = (typeof FeedbackDuplicateMethods)[keyof typeof FeedbackDuplicateMethods];

// ─── Intake (#182) ───────────────────────────────────────────────────────────

/** Where else in Mocco a request can be turned into a post: a messenger conversation for now;
 * app reviews (#94) and forum threads (#97) join as they land. */
export const FeedbackSourceTypes = { messengerConversation: 'messenger_conversation' } as const;
export type FeedbackSourceType = (typeof FeedbackSourceTypes)[keyof typeof FeedbackSourceTypes];
export const feedbackSourceTypeSchema = z.enum(Object.values(FeedbackSourceTypes));

/** How much of the request a post's source keeps, for the team to see why it exists. */
export const FEEDBACK_SOURCE_EXCERPT_MAX = 1000;

/** Turn a source into a post: a new one on `boardId`, or (with `intoPostId`) an existing one. */
export const feedbackConvertInputSchema = z.union([
  z.object({
    sourceType: feedbackSourceTypeSchema,
    sourceId: z.string().min(1).max(200),
    boardId: z.uuid(),
    title,
    body: body.optional(),
  }),
  z.object({
    sourceType: feedbackSourceTypeSchema,
    sourceId: z.string().min(1).max(200),
    intoPostId: z.uuid(),
  }),
]);
export type FeedbackConvertInput = z.infer<typeof feedbackConvertInputSchema>;

// ─── GitHub links (#178) ─────────────────────────────────────────────────────

/** What a post links to in a project's repos. */
export const FeedbackLinkKinds = { issue: 'issue', pullRequest: 'pull_request' } as const;
export type FeedbackLinkKind = (typeof FeedbackLinkKinds)[keyof typeof FeedbackLinkKinds];
export const feedbackLinkKindSchema = z.enum(Object.values(FeedbackLinkKinds));

/** A linked issue or pull request's state; only a pull request is ever `merged`. */
export const FeedbackLinkStates = { open: 'open', closed: 'closed', merged: 'merged' } as const;
export type FeedbackLinkState = (typeof FeedbackLinkStates)[keyof typeof FeedbackLinkStates];

/** The most issues or pull requests a picker search answers. */
export const FEEDBACK_LINK_SEARCH_LIMIT = 10;

/** Search a linked repo's issues or pull requests: words, or a number (`12`, `#12`). */
export const feedbackLinkSearchInputSchema = z.object({
  repoId: z.uuid(),
  kind: feedbackLinkKindSchema,
  query: z.string().trim().max(200),
});

/** Link an issue or pull request, by number, of a repo linked to the post's project. */
export const feedbackLinkCreateInputSchema = z.object({
  repoId: z.uuid(),
  kind: feedbackLinkKindSchema,
  number: z.int().min(1).max(2_147_483_647),
});
export type FeedbackLinkCreateInput = z.infer<typeof feedbackLinkCreateInputSchema>;

// ─── Shipping on release (#179) ──────────────────────────────────────────────

/** Where a ship suggestion is: waiting for the team, accepted or dismissed by them, or applied
 * without asking by a board in `auto_apply` mode. */
export const ShipSuggestionStates = {
  pending: 'pending',
  accepted: 'accepted',
  dismissed: 'dismissed',
  autoApplied: 'auto_applied',
} as const;
export type ShipSuggestionState = (typeof ShipSuggestionStates)[keyof typeof ShipSuggestionStates];

/** When a post counts as shipped by a release: once every link that counts has shipped, or
 * once any one has. */
export const ShipPolicies = { allLinksShipped: 'all_links_shipped', anyLinkShipped: 'any_link_shipped' } as const;
export type ShipPolicy = (typeof ShipPolicies)[keyof typeof ShipPolicies];
export const shipPolicySchema = z.enum(Object.values(ShipPolicies));

/** What a board does with a post a release shipped: ask the team (the default), or mark it
 * shipped at once. */
export const ShipModes = { suggest: 'suggest', autoApply: 'auto_apply' } as const;
export type ShipMode = (typeof ShipModes)[keyof typeof ShipModes];
export const shipModeSchema = z.enum(Object.values(ShipModes));

/** The longest release step name a board keeps (a `.mocco.yml` step's name). */
export const FEEDBACK_RELEASE_STEP_NAME_MAX = 100;

/** A board's release policy: whose releases ship its posts, and how. */
export const feedbackReleasePolicyInputSchema = z.object({
  /** The repo whose releases count; null turns shipping on release off. */
  releaseRepoId: z.uuid().nullable(),
  /** Only a release whose run succeeded this step counts; null = any release of the repo. */
  releaseStepName: z.string().trim().min(1).max(FEEDBACK_RELEASE_STEP_NAME_MAX).nullable(),
  shipPolicy: shipPolicySchema,
  shipMode: shipModeSchema,
});
export type FeedbackReleasePolicyInput = z.infer<typeof feedbackReleasePolicyInputSchema>;
