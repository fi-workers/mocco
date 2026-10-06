// `mocco_feedback_*` for what end users and the team add to a post (#473): who voted for it and
// what was said on it, and, as changes, a team comment, a vote recorded for an end user, and
// merging a duplicate into another post.
//
// Thin adapters (ADR 0025) over `VoteService`, `CommentService` and `MergeService`, the services
// the console's `feedback` router calls for the same answers and changes (`votes`, `comments`,
// `createComment`, `vote`, `mergePost`); each tool calls one of them, after `ProjectScope` has
// checked the caller's workspace, project and `Products.feedback`.
//
// The three changes have the locks of every changing tool (`openDecision`, `confirmThenApply`):
// `feedback:write`, the workspace's opt-in, and a confirmation naming exactly what would change.
// Each confirmation is bound to the state it was asked about, so an answer given after someone
// else changed that state is refused as a different change: a vote to whether the end user had
// one, a merge to both posts being unmerged (and the target's vote count shown). The services
// re-check the same rules under the posts' locks, closing the gap between the re-read and the write.
import {
  FeedbackLimits,
  FeedbackVoteSources,
  FeedbackVoteStates,
  feedbackCommentInputSchema,
  feedbackEndUserIdSchema,
} from '@mocco/common/feedback';
import { McpScopes } from '@mocco/common/mcp';
import { z } from 'zod';

import { confirmThenApply, openDecision, refused, requireScope } from '@backend/transport/mcp/tools/deciding';
import {
  excerptOf,
  feedbackRefusal,
  postArg,
  postLabel,
  projectArg,
  resolveFeedbackProject,
  responseFormatArg,
} from '@backend/transport/mcp/tools/feedback';
import { asJson, userIdOf, workspaceArg } from '@backend/transport/mcp/tools/runs';

import type { CommentService } from '@backend/domain/feedback/CommentService';
import type { MergeService } from '@backend/domain/feedback/MergeService';
import type { PostService } from '@backend/domain/feedback/PostService';
import type { FeedbackPostRow } from '@backend/domain/feedback/repos/post.repo';
import type { VoteService } from '@backend/domain/feedback/VoteService';
import type { ProjectScope } from '@backend/domain/mcp/ProjectScope';
import type { DecidingToolDeps, DecisionWords } from '@backend/transport/mcp/tools/deciding';
import type { CallToolResult, InputRequiredResult, McpServer, ServerContext } from '@modelcontextprotocol/server';

export interface FeedbackEngagementToolDeps extends DecidingToolDeps {
  feedbackPosts: Pick<PostService, 'requirePost'>;
  feedbackVotes: Pick<VoteService, 'list' | 'find' | 'vote'>;
  feedbackComments: Pick<CommentService, 'listForStaff' | 'createAsStaff'>;
  feedbackMerges: Pick<MergeService, 'merge'>;
  projects: Pick<ProjectScope, 'resolve'>;
}

export const FEEDBACK_COMMENT_TOOL = 'mocco_feedback_comment_create';
export const FEEDBACK_VOTE_TOOL = 'mocco_feedback_post_vote';
export const FEEDBACK_MERGE_TOOL = 'mocco_feedback_post_merge';

const DEFAULT_LIMIT = 20;
/** One below the service's page cap, since a list reads one more to know there is a next page. */
const MAX_LIMIT = FeedbackLimits.listMax - 1;

const pageArgs = {
  limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  offset: z.number().int().min(0).default(0).describe("Paging: the previous answer's `nextOffset`, as it was given."),
};

const votesInput = z.object({
  postId: postArg,
  workspaceId: workspaceArg,
  projectId: projectArg,
  ...pageArgs,
  responseFormat: responseFormatArg(
    "each vote's end user (the app's id for them), whether it counts yet (`counted`, or `pending` an email confirmation) and when",
    'adds where it came from, when it was counted, and the team member who recorded it (a user id)',
  ),
});

const commentsInput = z.object({
  postId: postArg,
  workspaceId: workspaceArg,
  projectId: projectArg,
  ...pageArgs,
  responseFormat: responseFormatArg(
    "each comment's author kind (team or end user), whether it is the official response or an internal note, the start of its body and when",
    'the whole body and who wrote it (a user id for the team, the app id for an end user)',
  ),
});

const commentInput = z.object({
  postId: postArg,
  body: feedbackCommentInputSchema.shape.body.describe('The comment, in Markdown.'),
  isOfficial: z
    .boolean()
    .default(false)
    .describe("The team's official response: public, and shown as the answer to the post."),
  isInternal: z.boolean().default(false).describe('An internal note: only the team sees it. Not with `isOfficial`.'),
  workspaceId: workspaceArg,
  projectId: projectArg,
});

const voteInput = z.object({
  postId: postArg,
  endUserId: feedbackEndUserIdSchema.describe(
    "The end user the vote is for, by the id the project's app knows them by (the user id it signs).",
  ),
  workspaceId: workspaceArg,
  projectId: projectArg,
});

const mergeInput = z.object({
  postId: postArg.describe('The duplicate: the post to merge away.'),
  intoPostId: z.uuid().describe('The post it repeats, on the same board, which keeps the votes.'),
  workspaceId: workspaceArg,
  projectId: projectArg,
});

export type ListVotesArgs = z.infer<typeof votesInput>;
export type ListCommentsArgs = z.infer<typeof commentsInput>;
export type CreateCommentArgs = z.infer<typeof commentInput>;
export type VoteArgs = z.infer<typeof voteInput>;
export type MergeArgs = z.infer<typeof mergeInput>;

/** The page and, when there is more, the offset to pass back for the next one. */
function paged<T>(rows: T[], args: { limit: number; offset: number }): { page: T[]; nextOffset?: number } {
  const page = rows.slice(0, args.limit);
  return { page, ...(rows.length > page.length && { nextOffset: args.offset + page.length }) };
}

export async function listVotes(deps: FeedbackEngagementToolDeps, args: ListVotesArgs, userId: string) {
  const scope = await resolveFeedbackProject(deps, userId, args);
  const rows = await deps.feedbackVotes.list(scope, args.postId, { limit: args.limit + 1, offset: args.offset });
  const { page, nextOffset } = paged(rows, args);
  const isDetailed = args.responseFormat === 'detailed';
  return {
    postId: args.postId,
    votes: page.map(vote => ({
      endUserId: vote.endUserId,
      state: vote.state,
      createdAt: vote.createdAt,
      ...(isDetailed && {
        id: vote.id,
        source: vote.source,
        countedAt: vote.countedAt,
        recordedByUserId: vote.recordedByUserId,
      }),
    })),
    ...(nextOffset !== undefined && { nextOffset }),
  };
}

export async function listComments(deps: FeedbackEngagementToolDeps, args: ListCommentsArgs, userId: string) {
  const scope = await resolveFeedbackProject(deps, userId, args);
  const rows = await deps.feedbackComments.listForStaff(scope, args.postId, {
    limit: args.limit + 1,
    offset: args.offset,
  });
  const { page, nextOffset } = paged(rows, args);
  const isDetailed = args.responseFormat === 'detailed';
  return {
    postId: args.postId,
    comments: page.map(comment => ({
      id: comment.id,
      authorKind: comment.authorKind,
      isOfficial: comment.isOfficial,
      isInternal: comment.isInternal,
      ...(isDetailed
        ? { body: comment.body, authorUserId: comment.authorUserId, authorEndUserId: comment.authorEndUserId }
        : excerptOf(comment)),
      createdAt: comment.createdAt,
    })),
    ...(nextOffset !== undefined && { nextOffset }),
  };
}

/** One permission for every feedback change, worded as the consent screen words it. */
const writeScope = () => ({
  name: McpScopes.feedbackWrite,
  allows: 'move, comment on, vote on and merge your feedback posts',
});

const commentWords: DecisionWords = {
  verb: 'comment on feedback posts',
  doing: 'Commenting on a feedback post',
  scope: writeScope(),
  instead: 'comment from the post in the Mocco console',
};
const voteWords: DecisionWords = {
  verb: 'record votes on feedback posts',
  doing: 'Recording a vote on a feedback post',
  scope: writeScope(),
  instead: 'record it from the post in the Mocco console',
};
const mergeWords: DecisionWords = {
  verb: 'merge feedback posts',
  doing: 'Merging feedback posts',
  scope: writeScope(),
  instead: 'merge them from the board in the Mocco console',
};

/** What a comment is, in the confirmation's words. */
const commentKind = (args: CreateCommentArgs) => {
  if (args.isOfficial) {
    return 'the official response (public)';
  }
  return args.isInternal ? 'an internal note (the team only)' : 'a public comment';
};

/** Comment on a post as the caller, once they confirm the exact text and kind. */
export async function createComment(
  deps: FeedbackEngagementToolDeps,
  args: CreateCommentArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openDecision(deps, ctx, args.workspaceId, commentWords);
    if ('content' in opened) {
      return opened;
    }
    if (args.isOfficial && args.isInternal) {
      return refused('An official response is public, so it cannot be internal. Pick one.');
    }
    const { userId, workspaceId, confirmations } = opened;
    const scope = await resolveFeedbackProject(deps, userId, { workspaceId, projectId: args.projectId });
    const post = await deps.feedbackPosts.requirePost(scope, args.postId);
    const change = {
      tool: FEEDBACK_COMMENT_TOOL,
      ...scope,
      postId: post.id,
      body: args.body,
      isOfficial: args.isOfficial,
      isInternal: args.isInternal,
    };
    const question = [
      `Comment on feedback post ${postLabel(post)}, as you?`,
      `As: ${commentKind(args)}`,
      '',
      args.body,
    ].join('\n');
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Post this comment',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        const comment = await deps.feedbackComments.createAsStaff(scope, userId, post.id, {
          body: args.body,
          isOfficial: args.isOfficial,
          isInternal: args.isInternal,
        });
        return asJson({
          created: true,
          commentId: comment.id,
          postId: post.id,
          isOfficial: comment.isOfficial,
          isInternal: comment.isInternal,
          at: comment.createdAt,
        });
      },
    });
  } catch (error) {
    return feedbackRefusal(error);
  }
}

/** Record an end user's vote on their behalf, once the caller confirms it. */
export async function recordVote(
  deps: FeedbackEngagementToolDeps,
  args: VoteArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openDecision(deps, ctx, args.workspaceId, voteWords);
    if ('content' in opened) {
      return opened;
    }
    const { userId, workspaceId, confirmations } = opened;
    const scope = await resolveFeedbackProject(deps, userId, { workspaceId, projectId: args.projectId });
    const post = await deps.feedbackPosts.requirePost(scope, args.postId);
    if (post.mergedIntoPostId !== null) {
      return refused(
        `Feedback post ${postLabel(post)} was merged into ${post.mergedIntoPostId}; vote on that post instead.`,
      );
    }
    const existing = await deps.feedbackVotes.find(scope, post.id, args.endUserId);
    if (existing?.state === FeedbackVoteStates.counted) {
      return asJson({
        changed: false,
        postId: post.id,
        endUserId: args.endUserId,
        reason: 'Their vote counts already.',
      });
    }
    // Bound to the vote they have now: if one is added or confirmed before the answer, ask again.
    const change = {
      tool: FEEDBACK_VOTE_TOOL,
      ...scope,
      postId: post.id,
      endUserId: args.endUserId,
      had: existing?.state ?? null,
    };
    const question = [
      `Record a vote for feedback post ${postLabel(post)} on behalf of end user "${args.endUserId}", as you?`,
      existing === undefined
        ? 'It counts at once, and they follow the post from then on.'
        : 'Their pending vote (waiting for an email confirmation) counts at once.',
      `Votes now: ${String(post.voteCount)}`,
    ].join('\n');
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Record this vote',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        const result = await deps.feedbackVotes.vote(scope, post.id, args.endUserId, {
          source: FeedbackVoteSources.staff,
          recordedByUserId: userId,
        });
        return asJson({
          changed: true,
          postId: result.post.id,
          endUserId: result.vote.endUserId,
          state: result.vote.state,
          voteCount: result.post.voteCount,
        });
      },
    });
  } catch (error) {
    return feedbackRefusal(error);
  }
}

/** Why a post can't take part in a merge, read before asking; null when it can. */
const mergedNote = (post: FeedbackPostRow) =>
  post.mergedIntoPostId === null ? null : `${postLabel(post)} was merged into ${post.mergedIntoPostId} already.`;

/** Merge a duplicate into the post it repeats as the caller, once they confirm both posts. */
export async function mergePosts(
  deps: FeedbackEngagementToolDeps,
  args: MergeArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openDecision(deps, ctx, args.workspaceId, mergeWords);
    if ('content' in opened) {
      return opened;
    }
    if (args.postId === args.intoPostId) {
      return refused('A post cannot be merged into itself.');
    }
    const { userId, workspaceId, confirmations } = opened;
    const scope = await resolveFeedbackProject(deps, userId, { workspaceId, projectId: args.projectId });
    const source = await deps.feedbackPosts.requirePost(scope, args.postId);
    const target = await deps.feedbackPosts.requirePost(scope, args.intoPostId);
    const note = mergedNote(source) ?? mergedNote(target);
    if (note !== null) {
      return refused(`${note} A merged post cannot be merged again or merged into.`);
    }
    if (source.boardId !== target.boardId) {
      return refused('Posts can only be merged on the same board.');
    }
    // Bound to both posts as they are now: unmerged, and the votes each had when asked. If
    // either is merged or voted on before the answer, the person is asked again.
    const change = {
      tool: FEEDBACK_MERGE_TOOL,
      ...scope,
      postId: source.id,
      intoPostId: target.id,
      boardId: source.boardId,
      sourceVotes: source.voteCount,
      targetVotes: target.voteCount,
    };
    const question = [
      `Merge feedback post ${postLabel(source)} into ${postLabel(target)}, as you?`,
      `Votes: ${String(source.voteCount)} on the duplicate, ${String(target.voteCount)} on the post it joins; someone who voted on both counts once.`,
      'Its votes and followers move over, and the duplicate is closed, keeping its comments and history. A merge cannot be undone.',
    ].join('\n');
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Merge these posts',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        const merged = await deps.feedbackMerges.merge(scope, userId, source.id, target.id);
        return asJson({
          merged: true,
          postId: merged.source.id,
          intoPostId: merged.target.id,
          status: merged.source.status,
          voteCount: merged.target.voteCount,
          at: merged.source.mergedAt,
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

export function registerFeedbackEngagementTools(server: McpServer, deps: FeedbackEngagementToolDeps): void {
  server.registerTool(
    'mocco_feedback_votes_list',
    {
      title: "List a feedback post's votes",
      description:
        "Who voted for a feedback post, newest first: each end user by the app's id for them, and whether their vote counts yet (`pending` waits for an email confirmation). Page with `limit` and `nextOffset`. Read-only.",
      inputSchema: votesInput,
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => asJson(await listVotes(deps, args, userIdOf(ctx))),
  );

  server.registerTool(
    'mocco_feedback_comments_list',
    {
      title: "Read a feedback post's comments",
      description:
        "A feedback post's comments as the team sees them, oldest first: end users' comments, the team's official response and internal notes (marked; the public board never shows them). Page with `limit` and `nextOffset`. Read-only.",
      inputSchema: commentsInput,
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => asJson(await listComments(deps, args, userIdOf(ctx))),
  );

  server.registerTool(
    FEEDBACK_COMMENT_TOOL,
    {
      title: 'Comment on a feedback post',
      description:
        'Comment on a feedback post as the signed-in person: a public comment, the official response (`isOfficial`) or an internal note only the team sees (`isInternal`). The person confirms the exact text in their client first, and it only works where the workspace allows agents to make changes.',
      inputSchema: commentInput,
      annotations: { ...changing, destructiveHint: false, idempotentHint: false },
      scopeChallenge: challenge('Commenting'),
    },
    async (args, ctx) => await createComment(deps, args, ctx),
  );

  server.registerTool(
    FEEDBACK_VOTE_TOOL,
    {
      title: 'Record a vote for an end user',
      description:
        "Record an end user's vote on a feedback post on their behalf (they asked by email, on a call…), as the signed-in person: it counts at once and they follow the post. One vote per end user; a vote that counts already is left as it is. The person confirms first, and it only works where the workspace allows agents to make changes.",
      inputSchema: voteInput,
      annotations: { ...changing, destructiveHint: false, idempotentHint: true },
      scopeChallenge: challenge('Recording a vote'),
    },
    async (args, ctx) => await recordVote(deps, args, ctx),
  );

  server.registerTool(
    FEEDBACK_MERGE_TOOL,
    {
      title: 'Merge duplicate feedback posts',
      description:
        'Merge a duplicate feedback post into the post it repeats on the same board, as the signed-in person: its votes and followers move over (someone who voted on both counts once) and the duplicate is closed, keeping its comments and history. It cannot be undone. The person confirms both posts first, and it only works where the workspace allows agents to make changes.',
      inputSchema: mergeInput,
      annotations: { ...changing, destructiveHint: true, idempotentHint: false },
      scopeChallenge: challenge('Merging posts'),
    },
    async (args, ctx) => await mergePosts(deps, args, ctx),
  );
}
