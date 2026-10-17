// `mocco_feedback_*` for where posts come from and which ones repeat each other: a board's
// suggested duplicates, a request elsewhere in Mocco (a messenger conversation) previewed as a
// post, the posts a request became and the requests a post came from, and, as changes, setting a
// suggested pair aside and converting a request into a post.
//
// Thin adapters (ADR 0025) over `DuplicateService` and `IntakeService`, the services the console's
// `feedback` router calls for the same answers and changes (`duplicates`, `dismissDuplicate`,
// `intakePreview`, `convertSource`, `sourcePosts`, `postSources`); each tool calls one of them,
// after `ProjectScope` has checked the caller's workspace, project and `Products.feedback`. The
// services look pairs, sources and posts up only inside that project, so another tenant's reads
// exactly like one that does not exist. Merging a pair is `mocco_feedback_post_merge`.
//
// The two changes have the locks of every changing tool (`openDecision`, `confirmThenApply`):
// `feedback:write`, the workspace's opt-in, and a confirmation naming exactly what would change.
// A dismissal is bound to the pair still being in the queue; a conversion to the request's words,
// its requester, the posts it became already and where it goes, so an answer given after any of
// those changed is refused as a different change.
import { FeedbackLimits, FeedbackSourceTypes, feedbackSourceTypeSchema } from '@mocco/common/feedback';
import { McpScopes } from '@mocco/common/mcp';
import { z } from 'zod';

import { confirmThenApply, openDecision, refused, requireScope } from '@backend/transport/mcp/tools/deciding';
import {
  FEEDBACK_WRITE_ALLOWS,
  excerptOf,
  feedbackRefusal,
  postArg,
  postLabel,
  projectArg,
  resolveFeedbackProject,
  responseFormatArg,
} from '@backend/transport/mcp/tools/feedback';
import { asJson, userIdOf, workspaceArg } from '@backend/transport/mcp/tools/runs';

import type { DuplicateService } from '@backend/domain/feedback/DuplicateService';
import type { IntakeService } from '@backend/domain/feedback/IntakeService';
import type { PostService } from '@backend/domain/feedback/PostService';
import type { FeedbackPostRow } from '@backend/domain/feedback/repos/post.repo';
import type { ProjectScope } from '@backend/domain/mcp/ProjectScope';
import type { DecidingToolDeps, DecisionWords } from '@backend/transport/mcp/tools/deciding';
import type { CallToolResult, InputRequiredResult, McpServer, ServerContext } from '@modelcontextprotocol/server';

export interface FeedbackIntakeToolDeps extends DecidingToolDeps {
  feedbackPosts: Pick<PostService, 'requirePost'>;
  feedbackDuplicates: Pick<DuplicateService, 'list' | 'countOpen' | 'requireOpen' | 'dismiss'>;
  feedbackIntake: Pick<IntakeService, 'preview' | 'convert' | 'postsOf' | 'sourcesOf'>;
  projects: Pick<ProjectScope, 'resolve'>;
}

export const FEEDBACK_DUPLICATE_DISMISS_TOOL = 'mocco_feedback_duplicate_dismiss';
export const FEEDBACK_INTAKE_CONVERT_TOOL = 'mocco_feedback_intake_convert';

const boardArg = z.uuid().describe('The board, as `mocco_feedback_boards_list` returns it.');
const sourceTypeArg = feedbackSourceTypeSchema
  .default(FeedbackSourceTypes.messengerConversation)
  .describe('Where the request is: `messenger_conversation` (the only kind for now).');
const sourceIdArg = z
  .string()
  .min(1)
  .max(200)
  .describe("The request's id there: a conversation id, as `mocco_messenger_conversations_search` returns it.");

const duplicatesInput = z.object({
  boardId: boardArg,
  workspaceId: workspaceArg,
  projectId: projectArg,
  limit: z.number().int().min(1).max(FeedbackLimits.listMax).default(20),
  responseFormat: responseFormatArg(
    "each pair's id, how alike (0 to 1, and by title words or by meaning), when it was suggested, and both posts' id, number, title, status and votes",
    "adds the start of both posts' bodies",
  ),
});

const dismissInput = z.object({
  duplicateId: z.uuid().describe('The suggested pair, as `mocco_feedback_duplicates_list` returns it.'),
  workspaceId: workspaceArg,
  projectId: projectArg,
});

const previewInput = z.object({
  boardId: boardArg.describe('The board it would become a post on, whose posts it may repeat.'),
  sourceType: sourceTypeArg,
  sourceId: sourceIdArg,
  workspaceId: workspaceArg,
  projectId: projectArg,
});

const convertInput = z.object({
  sourceType: sourceTypeArg,
  sourceId: sourceIdArg,
  boardId: boardArg
    .optional()
    .describe('A new post on this board. Give it with `title`, or give `intoPostId` instead.'),
  title: z
    .string()
    .trim()
    .min(1)
    .max(FeedbackLimits.titleMax)
    .optional()
    .describe("The new post's title; `mocco_feedback_intake_preview` suggests one."),
  body: z.string().trim().max(FeedbackLimits.bodyMax).optional().describe("The new post's details, in Markdown."),
  intoPostId: z
    .uuid()
    .optional()
    .describe('Add the request to this existing post instead of making a new one (not with `boardId`).'),
  workspaceId: workspaceArg,
  projectId: projectArg,
});

const sourcePostsInput = z.object({
  sourceType: sourceTypeArg,
  sourceId: sourceIdArg,
  workspaceId: workspaceArg,
  projectId: projectArg,
});

const postSourcesInput = z.object({
  postId: postArg,
  workspaceId: workspaceArg,
  projectId: projectArg,
  responseFormat: responseFormatArg(
    "each request's kind, id, the requester's end-user id (null for a guest) and when it was converted, with the start of its words",
    'the whole of its words and who converted it (a user id)',
  ),
});

export type ListDuplicatesArgs = z.infer<typeof duplicatesInput>;
export type DismissDuplicateArgs = z.infer<typeof dismissInput>;
export type PreviewIntakeArgs = z.infer<typeof previewInput>;
export type ConvertArgs = z.infer<typeof convertInput>;
export type SourcePostsArgs = z.infer<typeof sourcePostsInput>;
export type PostSourcesArgs = z.infer<typeof postSourcesInput>;

/** A post as a list shows it. */
const postSummary = (post: FeedbackPostRow) => ({
  id: post.id,
  number: post.number,
  title: post.title,
  status: post.status,
  voteCount: post.voteCount,
  ...(post.mergedIntoPostId !== null && { mergedIntoPostId: post.mergedIntoPostId }),
});

export async function listDuplicates(deps: FeedbackIntakeToolDeps, args: ListDuplicatesArgs, userId: string) {
  const scope = await resolveFeedbackProject(deps, userId, args);
  const pairs = await deps.feedbackDuplicates.list(scope, args.boardId, args.limit);
  const isDetailed = args.responseFormat === 'detailed';
  const shown = (post: FeedbackPostRow) => ({ ...postSummary(post), ...(isDetailed && excerptOf(post)) });
  return {
    boardId: args.boardId,
    openCount: await deps.feedbackDuplicates.countOpen(scope, args.boardId),
    pairs: pairs.map(pair => ({
      id: pair.candidate.id,
      score: pair.candidate.score,
      method: pair.candidate.method,
      createdAt: pair.candidate.createdAt,
      post: shown(pair.post),
      original: shown(pair.original),
    })),
  };
}

export async function previewIntake(deps: FeedbackIntakeToolDeps, args: PreviewIntakeArgs, userId: string) {
  const scope = await resolveFeedbackProject(deps, userId, args);
  const preview = await deps.feedbackIntake.preview(scope, args.sourceType, args.sourceId, args.boardId);
  return {
    boardId: args.boardId,
    source: {
      type: args.sourceType,
      id: args.sourceId,
      suggestedTitle: preview.source.suggestedTitle,
      excerpt: preview.source.excerpt,
      requesterEndUserId: preview.source.endUserId,
    },
    alreadyBecame: preview.linked.map(link => ({ ...postSummary(link.post), boardId: link.post.boardId })),
    similar: preview.similar.map(post => postSummary(post)),
  };
}

export async function listSourcePosts(deps: FeedbackIntakeToolDeps, args: SourcePostsArgs, userId: string) {
  const scope = await resolveFeedbackProject(deps, userId, args);
  const links = await deps.feedbackIntake.postsOf(scope, args.sourceType, args.sourceId);
  return {
    source: { type: args.sourceType, id: args.sourceId },
    posts: links.map(link => ({ ...postSummary(link.post), boardId: link.post.boardId, at: link.source.createdAt })),
  };
}

export async function listPostSources(deps: FeedbackIntakeToolDeps, args: PostSourcesArgs, userId: string) {
  const scope = await resolveFeedbackProject(deps, userId, args);
  await deps.feedbackPosts.requirePost(scope, args.postId);
  const sources = await deps.feedbackIntake.sourcesOf(scope, args.postId);
  const isDetailed = args.responseFormat === 'detailed';
  return {
    postId: args.postId,
    sources: sources.map(source => ({
      type: source.sourceType,
      id: source.sourceId,
      requesterEndUserId: source.endUserId,
      ...(isDetailed
        ? { excerpt: source.excerpt, convertedByUserId: source.createdByUserId }
        : excerptOf({ body: source.excerpt })),
      at: source.createdAt,
    })),
  };
}

const writeScope = { name: McpScopes.feedbackWrite, allows: FEEDBACK_WRITE_ALLOWS };
const dismissWords: DecisionWords = {
  verb: 'dismiss suggested duplicates',
  doing: 'Dismissing a suggested duplicate',
  scope: writeScope,
  instead: 'dismiss it from Possible duplicates in the Mocco console',
};
const convertWords: DecisionWords = {
  verb: 'convert requests to feedback posts',
  doing: 'Converting a request to a feedback post',
  scope: writeScope,
  instead: "convert it from the conversation's Feedback panel in the Mocco console",
};

/** Set a suggested pair aside as the caller, once they confirm both posts are different requests. */
export async function dismissDuplicate(
  deps: FeedbackIntakeToolDeps,
  args: DismissDuplicateArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openDecision(deps, ctx, args.workspaceId, dismissWords);
    if ('content' in opened) {
      return opened;
    }
    const { userId, workspaceId, confirmations } = opened;
    const scope = await resolveFeedbackProject(deps, userId, { workspaceId, projectId: args.projectId });
    // Refused before asking when it left the queue: dismissed, or either post merged.
    const pair = await deps.feedbackDuplicates.requireOpen(scope, args.duplicateId);
    const change = {
      tool: FEEDBACK_DUPLICATE_DISMISS_TOOL,
      ...scope,
      duplicateId: pair.candidate.id,
      postId: pair.post.id,
      originalPostId: pair.original.id,
    };
    const question = [
      `Mark feedback posts ${postLabel(pair.post)} and ${postLabel(pair.original)} as different requests, as you?`,
      'The pair leaves the possible duplicates and is never suggested again; both posts stay as they are. It is recorded in the audit trail.',
    ].join('\n');
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Dismiss this pair',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        // The service dismisses only an open pair, so a second answer is refused as not found.
        await deps.feedbackDuplicates.dismiss(scope, userId, pair.candidate.id);
        return asJson({ dismissed: true, duplicateId: pair.candidate.id });
      },
    });
  } catch (error) {
    return feedbackRefusal(error);
  }
}

/** Where a conversion goes: a new post on a board, or an existing post. */
type ConvertTarget =
  { kind: 'new'; boardId: string; title: string; body: string } | { kind: 'into'; post: FeedbackPostRow };

/** The target the arguments name, or a refusal saying what is missing. */
async function targetOf(
  deps: FeedbackIntakeToolDeps,
  scope: { workspaceId: string; projectId: string },
  args: ConvertArgs,
): Promise<ConvertTarget | string> {
  if (args.intoPostId !== undefined) {
    if (args.boardId !== undefined || args.title !== undefined || args.body !== undefined) {
      return 'Give either `intoPostId`, or `boardId` and `title` for a new post, not both.';
    }
    const post = await deps.feedbackPosts.requirePost(scope, args.intoPostId);
    if (post.mergedIntoPostId !== null) {
      return `Feedback post ${postLabel(post)} was merged into ${post.mergedIntoPostId}; add the request to that post instead.`;
    }
    return { kind: 'into', post };
  }
  if (args.boardId === undefined || args.title === undefined) {
    return 'A new post needs `boardId` and `title`; to add the request to an existing post, give `intoPostId`.';
  }
  return { kind: 'new', boardId: args.boardId, title: args.title, body: args.body ?? '' };
}

/** Turn a request into a new post, or add it to one, as the caller, once they confirm. */
export async function convertSource(
  deps: FeedbackIntakeToolDeps,
  args: ConvertArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openDecision(deps, ctx, args.workspaceId, convertWords);
    if ('content' in opened) {
      return opened;
    }
    const { userId, workspaceId, confirmations } = opened;
    const scope = await resolveFeedbackProject(deps, userId, { workspaceId, projectId: args.projectId });
    const target = await targetOf(deps, scope, args);
    if (typeof target === 'string') {
      return refused(target);
    }
    const { boardId } = target.kind === 'new' ? target : target.post;
    const preview = await deps.feedbackIntake.preview(scope, args.sourceType, args.sourceId, boardId);
    const became = preview.linked.map(link => link.post);
    const [already] = became;
    if (target.kind === 'new' && already !== undefined) {
      // The service answers that post and records nothing, so there is nothing to confirm.
      return asJson({
        changed: false,
        postId: already.id,
        number: already.number,
        reason: `This request became feedback post ${postLabel(already)} already. Add it to another post with \`intoPostId\`.`,
      });
    }
    if (target.kind === 'into' && became.some(post => post.id === target.post.id)) {
      return asJson({
        changed: false,
        postId: target.post.id,
        reason: `This request is on feedback post ${postLabel(target.post)} already.`,
      });
    }
    const { source } = preview;
    // Bound to the request's words and requester, the posts it became, and where it goes.
    const change = {
      tool: FEEDBACK_INTAKE_CONVERT_TOOL,
      ...scope,
      sourceType: args.sourceType,
      sourceId: args.sourceId,
      excerpt: source.excerpt,
      requester: source.endUserId,
      became: became.map(post => post.id),
      target:
        target.kind === 'new'
          ? { boardId: target.boardId, title: target.title, body: target.body }
          : { intoPostId: target.post.id },
    };
    const question = [
      target.kind === 'new'
        ? `Make this request a new feedback post "${target.title}", as you?`
        : `Add this request to feedback post ${postLabel(target.post)}, as you?`,
      ...(target.kind === 'new' && target.body !== '' ? ['', target.body, ''] : []),
      source.endUserId === null
        ? 'The requester is a guest known only by an email address, so no vote is recorded for them.'
        : `The requester ("${source.endUserId}") votes for it, unless they have already.`,
      ...(became.length === 0 ? [] : [`It is on ${became.map(post => postLabel(post)).join(', ')} already.`]),
      'The request, quoted:',
      source.excerpt,
    ].join('\n');
    return await confirmThenApply(ctx, confirmations, change, {
      label: target.kind === 'new' ? 'Create this post' : 'Add it to this post',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        const result = await deps.feedbackIntake.convert(scope, userId, {
          sourceType: args.sourceType,
          sourceId: args.sourceId,
          ...(target.kind === 'new'
            ? { boardId: target.boardId, title: target.title, ...(target.body !== '' && { body: target.body }) }
            : { intoPostId: target.post.id }),
        });
        return asJson({
          converted: true,
          postId: result.post.id,
          number: result.post.number,
          isNewPost: target.kind === 'new' && result.isNew,
          isVoteAdded: result.isVoteAdded,
          voteCount: result.post.voteCount,
        });
      },
    });
  } catch (error) {
    return feedbackRefusal(error);
  }
}

const challenge = (doing: string) =>
  requireScope(McpScopes.feedbackWrite, `${doing} needs your permission for this app to change your feedback posts`);
const changing = { readOnlyHint: false, openWorldHint: false } as const;

export function registerFeedbackIntakeTools(server: McpServer, deps: FeedbackIntakeToolDeps): void {
  server.registerTool(
    'mocco_feedback_duplicates_list',
    {
      title: 'List possible duplicate feedback posts',
      description:
        "A board's suggested duplicate pairs still to decide, the newest first, with both posts and how many are open. Merge one with `mocco_feedback_post_merge` (the newer `post` into the `original`), or set it aside with `mocco_feedback_duplicate_dismiss`. Read-only.",
      inputSchema: duplicatesInput,
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => asJson(await listDuplicates(deps, args, userIdOf(ctx))),
  );

  server.registerTool(
    FEEDBACK_DUPLICATE_DISMISS_TOOL,
    {
      title: 'Dismiss a suggested duplicate',
      description:
        'Mark a suggested duplicate pair as different requests, as the signed-in person: it leaves the queue and is never suggested again, and both posts stay as they are. The person confirms both posts first, and it only works where the workspace allows agents to make changes.',
      inputSchema: dismissInput,
      annotations: { ...changing, destructiveHint: false, idempotentHint: true },
      scopeChallenge: challenge('Dismissing a duplicate'),
    },
    async (args, ctx) => await dismissDuplicate(deps, args, ctx),
  );

  server.registerTool(
    'mocco_feedback_intake_preview',
    {
      title: 'Preview a request as a feedback post',
      description:
        "What converting a request (a messenger conversation) on a board starts from: a suggested title and the requester's words (never internal notes), who the requester is, the posts it became already, and up to five of the board's posts it may repeat. Read-only.",
      inputSchema: previewInput,
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => asJson(await previewIntake(deps, args, userIdOf(ctx))),
  );

  server.registerTool(
    FEEDBACK_INTAKE_CONVERT_TOOL,
    {
      title: 'Convert a request to a feedback post',
      description:
        "Turn a request (a messenger conversation) into a new feedback post on a board (`boardId`, `title`, `body`), or add it to an existing post (`intoPostId`), as the signed-in person. The request's words are kept with the post for the team, and a signed-in requester votes for it. A request that became a post already is not made a second one. The person confirms first, and it only works where the workspace allows agents to make changes.",
      inputSchema: convertInput,
      annotations: { ...changing, destructiveHint: false, idempotentHint: true },
      scopeChallenge: challenge('Converting a request'),
    },
    async (args, ctx) => await convertSource(deps, args, ctx),
  );

  server.registerTool(
    'mocco_feedback_source_posts_list',
    {
      title: 'List the posts a request became',
      description:
        'The feedback posts a request (a messenger conversation) became or was added to, oldest first. Read-only.',
      inputSchema: sourcePostsInput,
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => asJson(await listSourcePosts(deps, args, userIdOf(ctx))),
  );

  server.registerTool(
    'mocco_feedback_post_sources_list',
    {
      title: 'List where a feedback post came from',
      description:
        "The requests (messenger conversations) a feedback post came from, oldest first, with the requester's words: the team's view, never shown publicly. Read-only.",
      inputSchema: postSourcesInput,
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => asJson(await listPostSources(deps, args, userIdOf(ctx))),
  );
}
