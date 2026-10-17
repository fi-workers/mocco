// `mocco_feedback_ship_suggestions_*` — shipping on release (#179): which release runs shipped
// which posts and wait for the team, and, as changes, marking a run's posts shipped or setting
// its suggestions aside.
//
// Thin adapters (ADR 0025) over `ShipSuggestionService`, the service the console's `feedback`
// router calls for the inbox banner (`shipSuggestions`, `acceptShipSuggestions`,
// `dismissShipSuggestions`), and `ChangelogService.get` for the run's draft entry. Every call first
// goes through `ProjectScope` with `Products.feedback` and the caller's own id; the services look
// boards, suggestions and entries up only inside that project, so another tenant's reads exactly
// like one that does not exist.
//
// The team decides a run at a time on a board, as the banner does: accepting marks every post of
// the run still waiting shipped (and their email followers hear), dismissing leaves them as they
// are. Both have the locks of every changing tool (`openDecision`, `confirmThenApply`):
// `feedback:write`, the workspace's opt-in, and a confirmation naming the run and each post. The
// confirmation is bound to the run's waiting suggestions and each post's status and merge as
// shown, so a suggestion decided, added or a post moved or merged before the answer is refused as
// a different change. A run with nothing waiting is refused before asking, and so is accepting a
// run whose every post was merged or shipped meanwhile (nothing would ship; dismiss it instead).
import { FeedbackPostStatuses } from '@mocco/common/feedback';
import { McpScopes } from '@mocco/common/mcp';
import { z } from 'zod';

import { FeedbackShipSuggestionNotFoundError } from '@backend/domain/feedback/errors';
import { confirmThenApply, openDecision, refused, requireScope } from '@backend/transport/mcp/tools/deciding';
import {
  FEEDBACK_WRITE_ALLOWS,
  feedbackRefusal,
  postLabel,
  projectArg,
  resolveFeedbackProject,
  responseFormatArg,
} from '@backend/transport/mcp/tools/feedback';
import { asJson, userIdOf, workspaceArg } from '@backend/transport/mcp/tools/runs';

import type { BoardService } from '@backend/domain/feedback/BoardService';
import type { ChangelogService } from '@backend/domain/feedback/ChangelogService';
import type { FeedbackScope } from '@backend/domain/feedback/scope';
import type { PendingShipRun, ShipSuggestionService } from '@backend/domain/feedback/ShipSuggestionService';
import type { ProjectScope } from '@backend/domain/mcp/ProjectScope';
import type { DecidingToolDeps, DecisionWords } from '@backend/transport/mcp/tools/deciding';
import type { CallToolResult, InputRequiredResult, McpServer, ServerContext } from '@modelcontextprotocol/server';

export interface FeedbackShippingToolDeps extends DecidingToolDeps {
  feedbackBoards: Pick<BoardService, 'listBoards'>;
  feedbackShipSuggestions: Pick<ShipSuggestionService, 'listPending' | 'accept' | 'dismiss'>;
  feedbackChangelog: Pick<ChangelogService, 'get'>;
  projects: Pick<ProjectScope, 'resolve'>;
}

export const FEEDBACK_SHIP_ACCEPT_TOOL = 'mocco_feedback_ship_suggestions_accept';
export const FEEDBACK_SHIP_DISMISS_TOOL = 'mocco_feedback_ship_suggestions_dismiss';

const boardArg = z.uuid().describe('The board, as `mocco_feedback_boards_list` returns it.');
const runArg = z.uuid().describe('The release run, as `mocco_feedback_ship_suggestions_list` returns it.');

const listInput = z.object({
  boardId: boardArg.optional().describe("Only this board's suggestions. Omit it for every board of the project."),
  workspaceId: workspaceArg,
  projectId: projectArg,
  responseFormat: responseFormatArg(
    "each waiting run's board, run id, released commit, the gates it passed (who approved it), when it was suggested, its posts (suggestion id, post id, number, title, status, votes, and where a merged one went) and its draft changelog entry's id, title and state",
    "adds the draft's address, its body in Markdown and the posts it announces",
  ),
});

const decideInput = z.object({
  boardId: boardArg,
  runId: runArg,
  workspaceId: workspaceArg,
  projectId: projectArg,
});

export type ListShipSuggestionsArgs = z.infer<typeof listInput>;
export type DecideShipSuggestionsArgs = z.infer<typeof decideInput>;

/** The run's draft entry as the answer shows it, or null when it was deleted. */
async function draftOf(deps: FeedbackShippingToolDeps, scope: FeedbackScope, run: PendingShipRun, isDetailed: boolean) {
  if (run.changelogEntryId === null) {
    return null;
  }
  const entry = await deps.feedbackChangelog.get(scope, run.changelogEntryId);
  return {
    id: entry.id,
    title: entry.title,
    state: entry.state,
    ...(isDetailed && { slug: entry.slug, body: entry.bodyMd, postIds: entry.postIds }),
  };
}

export async function listShipSuggestions(
  deps: FeedbackShippingToolDeps,
  args: ListShipSuggestionsArgs,
  userId: string,
) {
  const scope = await resolveFeedbackProject(deps, userId, args);
  const boards = args.boardId === undefined ? await deps.feedbackBoards.listBoards(scope) : [{ id: args.boardId }];
  const boardIds = boards.map(board => board.id);
  const isDetailed = args.responseFormat === 'detailed';
  // One board at a time: production's pool is a single connection.
  const runs = await boardIds.reduce<Promise<Record<string, unknown>[]>>(async (previous, boardId) => {
    const done = await previous;
    const pending = await deps.feedbackShipSuggestions.listPending(scope, boardId);
    const shown = await Promise.all(
      pending.map(async run => ({
        boardId,
        runId: run.runId,
        commitSha: run.commitSha,
        approvedBy: run.gateNames,
        suggestedAt: run.suggestedAt,
        posts: run.posts.map(post => ({
          suggestionId: post.suggestionId,
          postId: post.id,
          number: post.number,
          title: post.title,
          status: post.status,
          voteCount: post.voteCount,
          ...(post.mergedIntoPostId !== null && { mergedIntoPostId: post.mergedIntoPostId }),
        })),
        changelogEntry: await draftOf(deps, scope, run, isDetailed),
      })),
    );
    return [...done, ...shown];
  }, Promise.resolve([]));
  return { projectId: scope.projectId, runs };
}

const decideScope = { name: McpScopes.feedbackWrite, allows: FEEDBACK_WRITE_ALLOWS };
const acceptWords: DecisionWords = {
  verb: 'mark feedback posts shipped',
  doing: 'Marking feedback posts shipped',
  scope: decideScope,
  instead: "mark them shipped from the board's inbox in the Mocco console",
};
const dismissWords: DecisionWords = {
  verb: 'dismiss ship suggestions',
  doing: 'Dismissing ship suggestions',
  scope: decideScope,
  instead: "dismiss them from the board's inbox in the Mocco console",
};

/** The run's suggestions waiting on the board, as they are now; refused when none wait. */
async function waitingRun(deps: FeedbackShippingToolDeps, scope: FeedbackScope, args: DecideShipSuggestionsArgs) {
  const pending = await deps.feedbackShipSuggestions.listPending(scope, args.boardId);
  const run = pending.find(each => each.runId === args.runId);
  if (run === undefined) {
    throw new FeedbackShipSuggestionNotFoundError(args.runId);
  }
  return run;
}

/** What the confirmation is bound to: the run, its waiting suggestions, and each post as shown. */
const boundTo = (tool: string, scope: FeedbackScope, args: DecideShipSuggestionsArgs, run: PendingShipRun) => ({
  tool,
  ...scope,
  boardId: args.boardId,
  runId: run.runId,
  posts: run.posts.map(post => ({
    suggestionId: post.suggestionId,
    postId: post.id,
    status: post.status,
    mergedIntoPostId: post.mergedIntoPostId,
  })),
});

/** Whether accepting would ship the post: not merged into another, and not shipped already. */
const isShipping = (post: PendingShipRun['posts'][number]) =>
  post.mergedIntoPostId === null && post.status !== FeedbackPostStatuses.shipped;

/** A post's line in a confirmation: what it is now, and what accepting does to it. */
function postLine(post: PendingShipRun['posts'][number]): string {
  const label = postLabel(post);
  if (post.mergedIntoPostId !== null) {
    return `- ${label}: merged into ${post.mergedIntoPostId}, left as it is`;
  }
  if (post.status === FeedbackPostStatuses.shipped) {
    return `- ${label}: shipped already`;
  }
  return `- ${label}: ${post.status} → shipped (${String(post.voteCount)} ${post.voteCount === 1 ? 'vote' : 'votes'})`;
}

const runLine = (run: PendingShipRun) => {
  const approved = run.gateNames.length === 0 ? '' : ` (approved by ${run.gateNames.join(', ')})`;
  return `Release run ${run.runId} at commit ${run.commitSha.slice(0, 7)}${approved}`;
};

/** Mark every post of the run still waiting on the board shipped, as the caller, once they confirm. */
export async function acceptShipSuggestions(
  deps: FeedbackShippingToolDeps,
  args: DecideShipSuggestionsArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openDecision(deps, ctx, args.workspaceId, acceptWords);
    if ('content' in opened) {
      return opened;
    }
    const { userId, workspaceId, confirmations } = opened;
    const scope = await resolveFeedbackProject(deps, userId, { workspaceId, projectId: args.projectId });
    const run = await waitingRun(deps, scope, args);
    const shipping = run.posts.filter(post => isShipping(post));
    if (shipping.length === 0) {
      return refused(
        `Every post release run ${run.runId} suggests was merged or shipped since, so accepting would ship nothing. Dismiss its suggestions instead.`,
      );
    }
    const question = [
      `Mark ${String(shipping.length)} feedback ${shipping.length === 1 ? 'post' : 'posts'} shipped, as you?`,
      runLine(run),
      ...run.posts.map(post => postLine(post)),
      "Each change is recorded in the post's history and the audit trail, and the email voters who follow it are mailed that it shipped.",
      run.changelogEntryId === null
        ? 'The draft changelog entry was deleted.'
        : 'The draft changelog entry stays a draft: publish it from the changelog when it is ready.',
    ].join('\n');
    return await confirmThenApply(ctx, confirmations, boundTo(FEEDBACK_SHIP_ACCEPT_TOOL, scope, args, run), {
      label: 'Mark these posts shipped',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        // The service locks the suggestions and the posts, so a post merged or shipped since the
        // re-read is decided without a change.
        const accepted = await deps.feedbackShipSuggestions.accept(scope, userId, args.boardId, run.runId);
        return asJson({ accepted: true, runId: run.runId, shipped: accepted.shipped });
      },
    });
  } catch (error) {
    return feedbackRefusal(error);
  }
}

/** Set the run's waiting suggestions on the board aside, as the caller, once they confirm. */
export async function dismissShipSuggestions(
  deps: FeedbackShippingToolDeps,
  args: DecideShipSuggestionsArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openDecision(deps, ctx, args.workspaceId, dismissWords);
    if ('content' in opened) {
      return opened;
    }
    const { userId, workspaceId, confirmations } = opened;
    const scope = await resolveFeedbackProject(deps, userId, { workspaceId, projectId: args.projectId });
    const run = await waitingRun(deps, scope, args);
    const question = [
      `Dismiss the ship ${run.posts.length === 1 ? 'suggestion' : 'suggestions'} for ${String(run.posts.length)} feedback ${run.posts.length === 1 ? 'post' : 'posts'}, as you?`,
      runLine(run),
      ...run.posts.map(post => `- ${postLabel(post)}: stays ${post.status}`),
      'The posts stay as they are and no one is mailed; The draft changelog entry is left as it is.',
    ].join('\n');
    return await confirmThenApply(ctx, confirmations, boundTo(FEEDBACK_SHIP_DISMISS_TOOL, scope, args, run), {
      label: 'Dismiss these suggestions',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        const dismissed = await deps.feedbackShipSuggestions.dismiss(scope, userId, args.boardId, run.runId);
        return asJson({ dismissed: true, runId: run.runId, suggestions: dismissed.dismissed });
      },
    });
  } catch (error) {
    return feedbackRefusal(error);
  }
}

const challenge = (doing: string) =>
  requireScope(McpScopes.feedbackWrite, `${doing} needs your permission for this app to change your feedback posts`);
const changing = { readOnlyHint: false, openWorldHint: false } as const;

export function registerFeedbackShippingTools(server: McpServer, deps: FeedbackShippingToolDeps): void {
  server.registerTool(
    'mocco_feedback_ship_suggestions_list',
    {
      title: 'List ship suggestions',
      description:
        "The release runs that shipped feedback posts and wait for the team to mark them shipped, the newest first, on one board or every board of the project: each run's released commit, who approved it (its gates), the posts it suggests and the draft changelog entry grouping them. Decide one with `mocco_feedback_ship_suggestions_accept` or `_dismiss`. Read-only.",
      inputSchema: listInput,
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => asJson(await listShipSuggestions(deps, args, userIdOf(ctx))),
  );

  server.registerTool(
    FEEDBACK_SHIP_ACCEPT_TOOL,
    {
      title: "Mark a release run's posts shipped",
      description:
        "Accept a release run's ship suggestions on a board, as the signed-in person and as the board's inbox does: every post of the run still waiting moves to `shipped`, recorded in its history and the audit trail, and its email voters are mailed. A post merged or shipped since is left as it is. The draft changelog entry stays a draft. The person confirms the run and its posts first, and it only works where the workspace allows agents to make changes.",
      inputSchema: decideInput,
      annotations: { ...changing, destructiveHint: false, idempotentHint: true },
      scopeChallenge: challenge('Marking posts shipped'),
    },
    async (args, ctx) => await acceptShipSuggestions(deps, args, ctx),
  );

  server.registerTool(
    FEEDBACK_SHIP_DISMISS_TOOL,
    {
      title: "Dismiss a release run's ship suggestions",
      description:
        "Set a release run's ship suggestions on a board aside, as the signed-in person: the posts stay as they are and no one is mailed. The person confirms the run and its posts first, and it only works where the workspace allows agents to make changes.",
      inputSchema: decideInput,
      annotations: { ...changing, destructiveHint: false, idempotentHint: true },
      scopeChallenge: challenge('Dismissing ship suggestions'),
    },
    async (args, ctx) => await dismissShipSuggestions(deps, args, ctx),
  );
}
