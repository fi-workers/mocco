// `mocco_feedback_*` — a project's feedback boards: which boards and categories it has, which
// posts are on a board and in what status, one post with its status history, and, as a change,
// moving a post to another status.
//
// Thin adapters (ADR 0025) over `BoardService` and `PostService`, the services the console's
// `feedback` router calls for the same answers and the same change (`boards`/`board`, `posts`,
// `post`, `setPostStatus`); each tool calls one of them. Feedback is project-scoped, so every
// call first goes through `ProjectScope` with `Products.feedback` and the caller's own id; the
// services then look a board or post up only inside that workspace and project, so another
// tenant's reads exactly like one that does not exist.
//
// Moving a post changes what the public roadmap shows (and, once voters are notified, who
// gets an email), so it has the locks of every changing tool (`openDecision`,
// `confirmThenApply` in `deciding.ts`): its own `feedback:write` scope, stepped up for per
// tool, the workspace's opt-in, and a confirmation that names the post and the status it goes
// from and to. The confirmation is bound to the status the post had when asked: if anyone
// moves it in between, the answer no longer matches, and the service re-checks the same
// status under the post's lock, so the change never lands on a post that has moved.
import { FeedbackLimits, FeedbackPostSorts, feedbackPostStatusSchema } from '@mocco/common/feedback';
import { McpScopes } from '@mocco/common/mcp';
import { Products } from '@mocco/common/project';
import { z } from 'zod';

import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '@backend/domain/errors';
import { confirmThenApply, openDecision, refused, requireScope } from '@backend/transport/mcp/tools/deciding';
import { asJson, userIdOf, workspaceArg } from '@backend/transport/mcp/tools/runs';

import type { BoardService } from '@backend/domain/feedback/BoardService';
import type { PostService } from '@backend/domain/feedback/PostService';
import type { FeedbackPostRow } from '@backend/domain/feedback/repos/post.repo';
import type { ProjectInScope, ProjectScope } from '@backend/domain/mcp/ProjectScope';
import type { DecidingToolDeps, DecisionWords } from '@backend/transport/mcp/tools/deciding';
import type { CallToolResult, InputRequiredResult, McpServer, ServerContext } from '@modelcontextprotocol/server';

export interface FeedbackToolDeps extends DecidingToolDeps {
  feedbackBoards: Pick<BoardService, 'listBoards' | 'getBoard'>;
  feedbackPosts: Pick<PostService, 'list' | 'get' | 'requirePost' | 'setStatus'>;
  projects: Pick<ProjectScope, 'resolve'>;
}

export const FEEDBACK_SET_STATUS_TOOL = 'mocco_feedback_post_set_status';

const DEFAULT_LIMIT = 20;
/** One below the service's page cap, since a search reads one more to know there is a next page. */
const MAX_LIMIT = FeedbackLimits.listMax - 1;
/** How much of a post's body a concise read (and a detailed search) shows. */
const EXCERPT_CHARS = 500;

const projectArg = z
  .uuid()
  .optional()
  .describe('The project the boards belong to. Omit it when the workspace has exactly one.');

const responseFormatArg = (concise: string, detailed: string) =>
  z.enum(['concise', 'detailed']).default('concise').describe(`\`concise\` is ${concise}; \`detailed\` ${detailed}.`);

const postArg = z.uuid().describe('The post id, as `mocco_feedback_posts_search` returns it.');

const boardsInput = z.object({
  workspaceId: workspaceArg,
  projectId: projectArg,
  responseFormat: responseFormatArg(
    "each board's id, address (slug), name, whether it is public, and its categories' ids and names in order",
    "adds each category's address and position, and when each board was made and last changed",
  ),
});

const searchInput = z.object({
  boardId: z.uuid().describe('The board to search, as `mocco_feedback_boards_list` returns it.'),
  workspaceId: workspaceArg,
  projectId: projectArg,
  status: feedbackPostStatusSchema
    .optional()
    .describe('Only posts in this status: `under_review`, `planned`, `in_progress`, `shipped` or `closed`.'),
  categoryId: z.uuid().optional().describe('Only posts in this category, as `mocco_feedback_boards_list` names it.'),
  sort: z
    .enum([FeedbackPostSorts.status, FeedbackPostSorts.newest])
    .default(FeedbackPostSorts.status)
    .describe(
      '`status` (the default): under review, planned, in progress, shipped, closed, newest first within each; `newest`: newest first.',
    ),
  limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  offset: z.number().int().min(0).default(0).describe("Paging: the previous answer's `nextOffset`, as it was given."),
  responseFormat: responseFormatArg(
    "each post's id, number, title, status, category id and when it was posted",
    'adds the start of its body, when it shipped and last changed, and who wrote it (a user id)',
  ),
});

const readInput = z.object({
  postId: postArg,
  workspaceId: workspaceArg,
  projectId: projectArg,
  responseFormat: responseFormatArg(
    `the post, the start of its body (${EXCERPT_CHARS} characters) and every status it took, oldest first`,
    'the whole body, who wrote it, and who made each status change (user ids)',
  ),
});

const moveInput = z.object({
  postId: postArg,
  status: feedbackPostStatusSchema.describe(
    'The status to move it to: `under_review`, `planned`, `in_progress`, `shipped` or `closed`.',
  ),
  workspaceId: workspaceArg,
  projectId: projectArg,
});

export type ListBoardsArgs = z.infer<typeof boardsInput>;
export type SearchPostsArgs = z.infer<typeof searchInput>;
export type GetPostArgs = z.infer<typeof readInput>;
export type SetStatusArgs = z.infer<typeof moveInput>;

const resolveFeedbackProject = async (deps: FeedbackToolDeps, userId: string, asked: Partial<ProjectInScope>) =>
  await deps.projects.resolve(userId, asked, Products.feedback);

/** The start of a body, and whether there is more of it. */
function excerptOf(post: Pick<FeedbackPostRow, 'body'>): { body: string; isBodyCut: boolean } {
  const isBodyCut = post.body.length > EXCERPT_CHARS;
  return { body: isBodyCut ? `${post.body.slice(0, EXCERPT_CHARS)}…` : post.body, isBodyCut };
}

export async function listBoards(deps: FeedbackToolDeps, args: ListBoardsArgs, userId: string) {
  const scope = await resolveFeedbackProject(deps, userId, args);
  const boards = await deps.feedbackBoards.listBoards(scope);
  const isDetailed = args.responseFormat === 'detailed';
  const withCategories = await Promise.all(
    boards.map(async each => await deps.feedbackBoards.getBoard(scope, each.id)),
  );
  return {
    projectId: scope.projectId,
    boards: withCategories.map(({ board, categories }) => ({
      id: board.id,
      slug: board.slug,
      name: board.name,
      isPublic: board.isPublic,
      categories: categories.map(category => ({
        id: category.id,
        name: category.name,
        ...(isDetailed && { slug: category.slug, position: category.position }),
      })),
      ...(isDetailed && { createdAt: board.createdAt, updatedAt: board.updatedAt }),
    })),
  };
}

export async function searchPosts(deps: FeedbackToolDeps, args: SearchPostsArgs, userId: string) {
  const scope = await resolveFeedbackProject(deps, userId, args);
  // One more than asked, to know whether there is a next page.
  const rows = await deps.feedbackPosts.list(scope, {
    boardId: args.boardId,
    sort: args.sort,
    limit: args.limit + 1,
    offset: args.offset,
    ...(args.status !== undefined && { status: args.status }),
    ...(args.categoryId !== undefined && { categoryId: args.categoryId }),
  });
  const page = rows.slice(0, args.limit);
  const isDetailed = args.responseFormat === 'detailed';
  return {
    boardId: args.boardId,
    posts: page.map(post => ({
      id: post.id,
      number: post.number,
      title: post.title,
      status: post.status,
      categoryId: post.categoryId,
      createdAt: post.createdAt,
      ...(isDetailed && {
        ...excerptOf(post),
        shippedAt: post.shippedAt,
        updatedAt: post.updatedAt,
        authorUserId: post.authorUserId,
      }),
    })),
    // Present when there is more: pass it back as `offset` for the next page.
    ...(rows.length > page.length && { nextOffset: args.offset + page.length }),
  };
}

export async function getPost(deps: FeedbackToolDeps, args: GetPostArgs, userId: string) {
  const scope = await resolveFeedbackProject(deps, userId, args);
  const { post, history } = await deps.feedbackPosts.get(scope, args.postId);
  const isDetailed = args.responseFormat === 'detailed';
  return {
    post: {
      id: post.id,
      boardId: post.boardId,
      number: post.number,
      title: post.title,
      status: post.status,
      categoryId: post.categoryId,
      ...(isDetailed ? { body: post.body, authorUserId: post.authorUserId } : excerptOf(post)),
      createdAt: post.createdAt,
      updatedAt: post.updatedAt,
      shippedAt: post.shippedAt,
    },
    history: history.map(change => ({
      from: change.fromStatus,
      to: change.toStatus,
      reason: change.reason,
      at: change.createdAt,
      ...(isDetailed && { actorUserId: change.actorUserId }),
    })),
  };
}

const moveWords: DecisionWords = {
  verb: 'change feedback statuses',
  doing: "Changing a feedback post's status",
  scope: { name: McpScopes.feedbackWrite, allows: 'move your feedback posts to another status' },
  instead: 'change it from the board in the Mocco console',
};

/** The refusals the model reads (not found, which another tenant's post reads as too, a
 * workspace or project to pick, the product off, a post that moved); anything else is rethrown. */
function feedbackRefusal(error: unknown): CallToolResult {
  if (
    error instanceof NotFoundError ||
    error instanceof BadRequestError ||
    error instanceof ForbiddenError ||
    error instanceof ConflictError
  ) {
    return refused(error.message);
  }
  throw error;
}

const postLabel = (post: FeedbackPostRow) => `#${String(post.number)} "${post.title}"`;

/** Move a post to another status as the caller, once they confirm the move from its status now. */
export async function setStatus(
  deps: FeedbackToolDeps,
  args: SetStatusArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openDecision(deps, ctx, args.workspaceId, moveWords);
    if ('content' in opened) {
      return opened;
    }
    const { userId, workspaceId, confirmations } = opened;
    const scope = await resolveFeedbackProject(deps, userId, { workspaceId, projectId: args.projectId });
    const post = await deps.feedbackPosts.requirePost(scope, args.postId);
    if (post.status === args.status) {
      return asJson({ changed: false, postId: post.id, status: post.status, reason: `It is ${post.status} already.` });
    }
    // Bound to the status it has now: if anyone moves it before the answer, the person is asked again.
    const change = { tool: FEEDBACK_SET_STATUS_TOOL, ...scope, postId: post.id, from: post.status, to: args.status };
    const question = [
      `Move feedback post ${postLabel(post)}, as you?`,
      `From: ${post.status}`,
      `To: ${args.status}`,
      'The change is recorded in its history and the audit trail, and a public board shows the new status.',
    ].join('\n');
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Move this post',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        // The service checks `from` again under the post's lock, closing the gap since the re-read.
        const moved = await deps.feedbackPosts.setStatus(scope, userId, post.id, args.status, { from: post.status });
        return asJson({
          changed: true,
          postId: moved.post.id,
          number: moved.post.number,
          from: moved.change.fromStatus,
          to: moved.change.toStatus,
          shippedAt: moved.post.shippedAt,
          at: moved.change.createdAt,
        });
      },
    });
  } catch (error) {
    return feedbackRefusal(error);
  }
}

export function registerFeedbackTools(server: McpServer, deps: FeedbackToolDeps): void {
  server.registerTool(
    'mocco_feedback_boards_list',
    {
      title: 'List feedback boards',
      description:
        "A project's feedback boards, each with its categories in order: the ids `mocco_feedback_posts_search` filters by. Read-only.",
      inputSchema: boardsInput,
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => asJson(await listBoards(deps, args, userIdOf(ctx))),
  );

  server.registerTool(
    'mocco_feedback_posts_search',
    {
      title: 'Find feedback posts',
      description:
        "A board's posts, by status in workflow order (newest first within a status) or newest first. Filter by status or category; page with `limit` and `nextOffset`. Read-only.",
      inputSchema: searchInput,
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => asJson(await searchPosts(deps, args, userIdOf(ctx))),
  );

  server.registerTool(
    'mocco_feedback_post_get',
    {
      title: 'Read a feedback post',
      description:
        'One feedback post with every status it took, oldest first, and why (created, or changed by hand). Concise cuts the body short; detailed has it whole. Read-only.',
      inputSchema: readInput,
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => asJson(await getPost(deps, args, userIdOf(ctx))),
  );

  server.registerTool(
    FEEDBACK_SET_STATUS_TOOL,
    {
      title: "Change a feedback post's status",
      description:
        "Move a feedback post to another status (`under_review`, `planned`, `in_progress`, `shipped` or `closed`), as the signed-in person, exactly as the board in the console does: it is recorded in the post's history and the audit trail. The person is asked to confirm the move from the post's current status in their client first, and it only works where the workspace allows agents to make changes.",
      inputSchema: moveInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      scopeChallenge: requireScope(
        McpScopes.feedbackWrite,
        'Changing a status needs your permission for this app to move your feedback posts to another status',
      ),
    },
    async (args, ctx) => await setStatus(deps, args, ctx),
  );
}
