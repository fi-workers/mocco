// `mocco_feedback_*` for who follows a post and taking a vote back: a post's subscribers, and, as
// a change, removing an end user's vote on their behalf.
//
// Thin adapters (ADR 0025) over `SubscriptionService.list` and `VoteService.unvote`, the methods
// the console's `feedback` router calls (`subscribers`, `unvote`), after `ProjectScope` has
// checked the caller's workspace, project and `Products.feedback`. Recording a vote is
// `mocco_feedback_post_vote`.
//
// Removing a vote has the locks of every changing tool (`openDecision`, `confirmThenApply`):
// `feedback:write`, the workspace's opt-in, and a confirmation naming the post, the end user and
// whether their vote counts. It is bound to the vote as shown, so a vote confirmed or removed by
// anyone before the answer is refused as a different change; an end user with no vote answers
// without asking.
import { FeedbackLimits, FeedbackVoteStates, feedbackEndUserIdSchema } from '@mocco/common/feedback';
import { McpScopes } from '@mocco/common/mcp';
import { z } from 'zod';

import { confirmThenApply, openDecision, refused, requireScope } from '@backend/transport/mcp/tools/deciding';
import {
  FEEDBACK_WRITE_ALLOWS,
  feedbackRefusal,
  postArg,
  postLabel,
  projectArg,
  resolveFeedbackProject,
} from '@backend/transport/mcp/tools/feedback';
import { asJson, userIdOf, workspaceArg } from '@backend/transport/mcp/tools/runs';

import type { PostService } from '@backend/domain/feedback/PostService';
import type { SubscriptionService } from '@backend/domain/feedback/SubscriptionService';
import type { VoteService } from '@backend/domain/feedback/VoteService';
import type { ProjectScope } from '@backend/domain/mcp/ProjectScope';
import type { DecidingToolDeps, DecisionWords } from '@backend/transport/mcp/tools/deciding';
import type { CallToolResult, InputRequiredResult, McpServer, ServerContext } from '@modelcontextprotocol/server';

export interface FeedbackFollowerToolDeps extends DecidingToolDeps {
  feedbackPosts: Pick<PostService, 'requirePost'>;
  feedbackVotes: Pick<VoteService, 'find' | 'unvote'>;
  feedbackSubscriptions: Pick<SubscriptionService, 'list'>;
  projects: Pick<ProjectScope, 'resolve'>;
}

export const FEEDBACK_UNVOTE_TOOL = 'mocco_feedback_post_unvote';

const DEFAULT_LIMIT = 20;
/** One below the service's page cap, since a list reads one more to know there is a next page. */
const MAX_LIMIT = FeedbackLimits.listMax - 1;

const subscribersInput = z.object({
  postId: postArg,
  workspaceId: workspaceArg,
  projectId: projectArg,
  limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  offset: z.number().int().min(0).default(0).describe("Paging: the previous answer's `nextOffset`, as it was given."),
});

const unvoteInput = z.object({
  postId: postArg,
  endUserId: feedbackEndUserIdSchema.describe(
    "The end user whose vote to remove, by the id the project's app knows them by (as `mocco_feedback_votes_list` shows it).",
  ),
  workspaceId: workspaceArg,
  projectId: projectArg,
});

export type ListSubscribersArgs = z.infer<typeof subscribersInput>;
export type UnvoteArgs = z.infer<typeof unvoteInput>;

export async function listSubscribers(deps: FeedbackFollowerToolDeps, args: ListSubscribersArgs, userId: string) {
  const scope = await resolveFeedbackProject(deps, userId, args);
  // One more than asked, to know whether there is a next page.
  const rows = await deps.feedbackSubscriptions.list(scope, args.postId, {
    limit: args.limit + 1,
    offset: args.offset,
  });
  const page = rows.slice(0, args.limit);
  return {
    postId: args.postId,
    subscribers: page.map(row => ({ endUserId: row.endUserId, since: row.createdAt })),
    ...(rows.length > page.length && { nextOffset: args.offset + page.length }),
  };
}

const unvoteWords: DecisionWords = {
  verb: 'remove votes on feedback posts',
  doing: 'Removing a vote on a feedback post',
  scope: { name: McpScopes.feedbackWrite, allows: FEEDBACK_WRITE_ALLOWS },
  instead: 'remove it from the post in the Mocco console',
};

/** Take an end user's vote back on their behalf, once the caller confirms it. */
export async function removeVote(
  deps: FeedbackFollowerToolDeps,
  args: UnvoteArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openDecision(deps, ctx, args.workspaceId, unvoteWords);
    if ('content' in opened) {
      return opened;
    }
    const { userId, workspaceId, confirmations } = opened;
    const scope = await resolveFeedbackProject(deps, userId, { workspaceId, projectId: args.projectId });
    const post = await deps.feedbackPosts.requirePost(scope, args.postId);
    if (post.mergedIntoPostId !== null) {
      return refused(
        `Feedback post ${postLabel(post)} was merged into ${post.mergedIntoPostId}, and its votes moved there; remove the vote on that post instead.`,
      );
    }
    const vote = await deps.feedbackVotes.find(scope, post.id, args.endUserId);
    if (vote === undefined) {
      return asJson({ changed: false, postId: post.id, endUserId: args.endUserId, reason: 'They have no vote on it.' });
    }
    const isCounted = vote.state === FeedbackVoteStates.counted;
    // Bound to the vote as it is now: confirmed or removed before the answer, ask again.
    const change = {
      tool: FEEDBACK_UNVOTE_TOOL,
      ...scope,
      postId: post.id,
      endUserId: args.endUserId,
      had: vote.state,
    };
    const question = [
      `Remove end user "${args.endUserId}"'s vote on feedback post ${postLabel(post)}, as you?`,
      isCounted
        ? `Votes now: ${String(post.voteCount)}, then ${String(post.voteCount - 1)}.`
        : 'Their vote is pending an email confirmation, so the count stays the same.',
      'They keep following the post.',
    ].join('\n');
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Remove this vote',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        const after = await deps.feedbackVotes.unvote(scope, post.id, args.endUserId);
        return asJson({ changed: true, postId: after.id, endUserId: args.endUserId, voteCount: after.voteCount });
      },
    });
  } catch (error) {
    return feedbackRefusal(error);
  }
}

export function registerFeedbackFollowerTools(server: McpServer, deps: FeedbackFollowerToolDeps): void {
  server.registerTool(
    'mocco_feedback_subscribers_list',
    {
      title: "List a feedback post's followers",
      description:
        "Who follows a feedback post, oldest first: each end user by the app's id for them (an email voter as `email:` and the address). Voters follow unless they opted out; those who unsubscribed are left out. Page with `limit` and `nextOffset`. Read-only.",
      inputSchema: subscribersInput,
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => asJson(await listSubscribers(deps, args, userIdOf(ctx))),
  );

  server.registerTool(
    FEEDBACK_UNVOTE_TOOL,
    {
      title: "Remove an end user's vote",
      description:
        "Remove an end user's vote on a feedback post on their behalf (they asked, or it was recorded by mistake), as the signed-in person; they keep following the post. The person confirms first, and it only works where the workspace allows agents to make changes.",
      inputSchema: unvoteInput,
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: true, idempotentHint: true },
      scopeChallenge: requireScope(
        McpScopes.feedbackWrite,
        'Removing a vote needs your permission for this app to change your feedback posts',
      ),
    },
    async (args, ctx) => await removeVote(deps, args, ctx),
  );
}
