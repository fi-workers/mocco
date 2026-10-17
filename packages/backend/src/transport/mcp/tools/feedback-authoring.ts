// `mocco_feedback_*` for setting a board up and writing posts as the team: one board with its
// release policy, and, as changes, creating and editing boards, their categories and release
// policy, and creating and editing posts.
//
// Thin adapters (ADR 0025) over `BoardService` and `PostService`, the services the console's
// `feedback` router calls for the same answers and changes (`board`, `createBoard`, `updateBoard`,
// `setReleasePolicy`, `createCategory`, `updateCategory`, `deleteCategory`, `createPost`,
// `updatePost`); each tool calls one of them, after `ProjectScope` has checked the caller's
// workspace, project and `Products.feedback`. The services look boards, categories and posts up
// only inside that project, so another tenant's reads exactly like one that does not exist.
//
// Every change has the locks of every changing tool (`openDecision`, `confirmThenApply`):
// `feedback:write`, the workspace's opt-in, and a confirmation naming exactly what would change.
// An edit is bound to what the board, category or post was when the person was asked, so an
// answer given after anyone else changed it is refused as a different change and the next call
// asks with what is there then. A taken address is refused before asking.
//
// Deleting a board is deliberately not here: it deletes every post, vote, comment, follower and
// changelog entry on it with no undo, and stays in the console, where the person deleting it is
// the one looking at it.
import { createHash } from 'node:crypto';

import {
  FeedbackLimits,
  FeedbackPostSorts,
  FeedbackPostStatuses,
  ShipModes,
  ShipPolicies,
  feedbackBoardInputSchema,
  feedbackCategoryInputSchema,
  feedbackPostCreateInputSchema,
  feedbackPostStatusSchema,
  feedbackReleasePolicyInputSchema,
} from '@mocco/common/feedback';
import { McpScopes } from '@mocco/common/mcp';
import { z } from 'zod';

import { FeedbackCategoryNotFoundError, FeedbackSlugTakenError } from '@backend/domain/feedback/errors';
import { confirmThenApply, openDecision, requireScope } from '@backend/transport/mcp/tools/deciding';
import {
  FEEDBACK_WRITE_ALLOWS,
  feedbackRefusal,
  postArg,
  postLabel,
  projectArg,
  resolveFeedbackProject,
  responseFormatArg,
} from '@backend/transport/mcp/tools/feedback';
import { asJson, userIdOf, workspaceArg } from '@backend/transport/mcp/tools/runs';

import type { BoardService } from '@backend/domain/feedback/BoardService';
import type { PostService } from '@backend/domain/feedback/PostService';
import type { FeedbackBoardRow } from '@backend/domain/feedback/repos/board.repo';
import type { FeedbackCategoryRow } from '@backend/domain/feedback/repos/category.repo';
import type { FeedbackScope } from '@backend/domain/feedback/scope';
import type { ProjectScope } from '@backend/domain/mcp/ProjectScope';
import type { DecidingToolDeps, DecisionWords } from '@backend/transport/mcp/tools/deciding';
import type { FeedbackReleasePolicyInput } from '@mocco/common/feedback';
import type { CallToolResult, InputRequiredResult, McpServer, ServerContext } from '@modelcontextprotocol/server';

export interface FeedbackAuthoringToolDeps extends DecidingToolDeps {
  feedbackBoards: Pick<
    BoardService,
    | 'listBoards'
    | 'getBoard'
    | 'createBoard'
    | 'updateBoard'
    | 'setReleasePolicy'
    | 'createCategory'
    | 'updateCategory'
    | 'deleteCategory'
  >;
  feedbackPosts: Pick<PostService, 'list' | 'requirePost' | 'create' | 'update'>;
  projects: Pick<ProjectScope, 'resolve'>;
}

export const FEEDBACK_BOARD_CREATE_TOOL = 'mocco_feedback_board_create';
export const FEEDBACK_BOARD_UPDATE_TOOL = 'mocco_feedback_board_update';
export const FEEDBACK_RELEASE_POLICY_TOOL = 'mocco_feedback_board_release_policy_set';
export const FEEDBACK_CATEGORY_CREATE_TOOL = 'mocco_feedback_category_create';
export const FEEDBACK_CATEGORY_UPDATE_TOOL = 'mocco_feedback_category_update';
export const FEEDBACK_CATEGORY_DELETE_TOOL = 'mocco_feedback_category_delete';
export const FEEDBACK_POST_CREATE_TOOL = 'mocco_feedback_post_create';
export const FEEDBACK_POST_UPDATE_TOOL = 'mocco_feedback_post_update';

const boardArg = z.uuid().describe('The board, as `mocco_feedback_boards_list` returns it.');
const categoryArg = z.uuid().describe("The category, as `mocco_feedback_board_get` lists the board's categories.");
const slugArg = feedbackBoardInputSchema.shape.slug.describe(
  'The address: lowercase letters, digits and single hyphens, as in `feature-requests`.',
);
const nameArg = feedbackBoardInputSchema.shape.name.describe(
  `The name people see, at most ${String(FeedbackLimits.nameMax)} characters.`,
);
const isPublicArg = z
  .boolean()
  .describe('Whether end users see it: its public board, roadmap and changelog pages and its /v1 routes.');
const positionArg = feedbackCategoryInputSchema.shape.position.describe(
  "Where it sits in the board's category order, from 0. A new category goes last unless given.",
);
const titleArg = feedbackPostCreateInputSchema.shape.title.describe('The post title.');
const bodyArg = z.string().trim().max(FeedbackLimits.bodyMax).describe('The details, in Markdown.');

const boardReadInput = z.object({
  boardId: boardArg,
  workspaceId: workspaceArg,
  projectId: projectArg,
  responseFormat: responseFormatArg(
    "the board (id, address, name, public), its release policy and its categories' ids and names in order",
    "adds each category's address and position, and when the board was made and last changed",
  ),
});

const boardCreateInput = z.object({
  slug: slugArg,
  name: nameArg,
  isPublic: isPublicArg.default(true),
  workspaceId: workspaceArg,
  projectId: projectArg,
});

const boardUpdateInput = z.object({
  boardId: boardArg,
  slug: slugArg.optional().describe('A new address. Its public pages move to it. Omit it to keep the address.'),
  name: nameArg.optional().describe('A new name. Omit it to keep the name.'),
  isPublic: isPublicArg.optional().describe('Make it public or private. Omit it to keep it as it is.'),
  workspaceId: workspaceArg,
  projectId: projectArg,
});

const { shape: policyShape } = feedbackReleasePolicyInputSchema;
const policyInput = z.object({
  boardId: boardArg,
  releaseRepoId: policyShape.releaseRepoId
    .optional()
    .describe(
      "The repo whose releases ship the board's posts: one linked to the project. `null` turns shipping on release off. Omit it to keep it.",
    ),
  releaseStepName: policyShape.releaseStepName
    .optional()
    .describe(
      'Only a release whose run succeeded the step of this name counts; `null` for any release of the repo. Omit it to keep it.',
    ),
  shipPolicy: policyShape.shipPolicy
    .optional()
    .describe(
      '`all_links_shipped`: a post ships once every pull request or issue it links has shipped; `any_link_shipped`: once one has. Omit it to keep it.',
    ),
  shipMode: policyShape.shipMode
    .optional()
    .describe(
      '`suggest`: ask the team in the inbox first; `auto_apply`: mark the posts shipped at once, mailing their email voters. Omit it to keep it.',
    ),
  workspaceId: workspaceArg,
  projectId: projectArg,
});

const categoryCreateInput = z.object({
  boardId: boardArg,
  slug: slugArg,
  name: nameArg,
  position: positionArg,
  workspaceId: workspaceArg,
  projectId: projectArg,
});

const categoryUpdateInput = z.object({
  boardId: boardArg,
  categoryId: categoryArg,
  slug: slugArg.optional().describe('A new address. Omit it to keep the address.'),
  name: nameArg.optional().describe('A new name. Omit it to keep the name.'),
  position: positionArg.describe('A new place in the order. Omit it to keep its place.'),
  workspaceId: workspaceArg,
  projectId: projectArg,
});

const categoryDeleteInput = z.object({
  boardId: boardArg,
  categoryId: categoryArg,
  workspaceId: workspaceArg,
  projectId: projectArg,
});

const postCreateInput = z.object({
  boardId: boardArg,
  title: titleArg,
  body: bodyArg.optional(),
  categoryId: z.uuid().optional().describe("One of the board's categories. Omit it for none."),
  status: feedbackPostStatusSchema
    .optional()
    .describe('Its first status: `under_review` (the default), `planned`, `in_progress`, `shipped` or `closed`.'),
  workspaceId: workspaceArg,
  projectId: projectArg,
});

const postUpdateInput = z.object({
  postId: postArg,
  title: titleArg.optional().describe('A new title. Omit it to keep the title.'),
  body: bodyArg.optional().describe('New details, in Markdown, replacing the old ones. Omit them to keep them.'),
  categoryId: z
    .uuid()
    .nullable()
    .optional()
    .describe("One of the board's categories; `null` takes the post out of its category. Omit it to keep it."),
  workspaceId: workspaceArg,
  projectId: projectArg,
});

export type GetBoardArgs = z.infer<typeof boardReadInput>;
export type CreateBoardArgs = z.infer<typeof boardCreateInput>;
export type UpdateBoardArgs = z.infer<typeof boardUpdateInput>;
export type SetReleasePolicyArgs = z.infer<typeof policyInput>;
export type CreateCategoryArgs = z.infer<typeof categoryCreateInput>;
export type UpdateCategoryArgs = z.infer<typeof categoryUpdateInput>;
export type DeleteCategoryArgs = z.infer<typeof categoryDeleteInput>;
export type CreatePostArgs = z.infer<typeof postCreateInput>;
export type UpdatePostArgs = z.infer<typeof postUpdateInput>;

const policyOf = (board: FeedbackBoardRow): FeedbackReleasePolicyInput => ({
  releaseRepoId: board.releaseRepoId,
  releaseStepName: board.releaseStepName,
  shipPolicy: board.shipPolicy,
  shipMode: board.shipMode,
});

export async function getBoard(deps: FeedbackAuthoringToolDeps, args: GetBoardArgs, userId: string) {
  const scope = await resolveFeedbackProject(deps, userId, args);
  const { board, categories } = await deps.feedbackBoards.getBoard(scope, args.boardId);
  const isDetailed = args.responseFormat === 'detailed';
  return {
    board: {
      id: board.id,
      slug: board.slug,
      name: board.name,
      isPublic: board.isPublic,
      releasePolicy: policyOf(board),
      ...(isDetailed && { createdAt: board.createdAt, updatedAt: board.updatedAt }),
    },
    categories: categories.map(category => ({
      id: category.id,
      name: category.name,
      ...(isDetailed && { slug: category.slug, position: category.position }),
    })),
  };
}

const writeScope = { name: McpScopes.feedbackWrite, allows: FEEDBACK_WRITE_ALLOWS };
const boardWords: DecisionWords = {
  verb: 'set up feedback boards',
  doing: 'Setting up a feedback board',
  scope: writeScope,
  instead: 'change it from Boards in the Mocco console',
};
const policyWords: DecisionWords = {
  verb: "change a feedback board's release policy",
  doing: "Changing a feedback board's release policy",
  scope: writeScope,
  instead: 'change it under Shipping on release in Boards in the Mocco console',
};
const categoryWords: DecisionWords = {
  verb: 'change feedback categories',
  doing: 'Changing a feedback category',
  scope: writeScope,
  instead: 'change it from Boards in the Mocco console',
};
const postWords: DecisionWords = {
  verb: 'write feedback posts',
  doing: 'Writing a feedback post',
  scope: writeScope,
  instead: 'write it from the board in the Mocco console',
};

const visibility = (isPublic: boolean) => (isPublic ? 'public (end users see it)' : 'private (only the team sees it)');
const boardLabel = (board: Pick<FeedbackBoardRow, 'name' | 'slug'>) => `"${board.name}" (${board.slug})`;

/** A taken board address, refused before asking: another board of the project has it. */
async function refuseTakenBoardSlug(
  deps: FeedbackAuthoringToolDeps,
  scope: FeedbackScope,
  slug: string,
  boardId?: string,
): Promise<void> {
  const boards = await deps.feedbackBoards.listBoards(scope);
  if (boards.some(board => board.slug === slug && board.id !== boardId)) {
    throw new FeedbackSlugTakenError('board', slug);
  }
}

/** Create a board as the caller, once they confirm its address, name and visibility. */
export async function createBoard(
  deps: FeedbackAuthoringToolDeps,
  args: CreateBoardArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openDecision(deps, ctx, args.workspaceId, boardWords);
    if ('content' in opened) {
      return opened;
    }
    const { userId, workspaceId, confirmations } = opened;
    const scope = await resolveFeedbackProject(deps, userId, { workspaceId, projectId: args.projectId });
    await refuseTakenBoardSlug(deps, scope, args.slug);
    const change = {
      tool: FEEDBACK_BOARD_CREATE_TOOL,
      ...scope,
      slug: args.slug,
      name: args.name,
      isPublic: args.isPublic,
    };
    const question = [
      `Create the feedback board ${boardLabel(args)}, as you?`,
      `Visibility: ${visibility(args.isPublic)}`,
      'It starts empty, with no categories and shipping on release off. Creating it is recorded in the audit trail.',
    ].join('\n');
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Create this board',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        const board = await deps.feedbackBoards.createBoard(scope, userId, {
          slug: args.slug,
          name: args.name,
          isPublic: args.isPublic,
        });
        return asJson({
          created: true,
          boardId: board.id,
          slug: board.slug,
          name: board.name,
          isPublic: board.isPublic,
        });
      },
    });
  } catch (error) {
    return feedbackRefusal(error);
  }
}

/** Rename a board, move its address or change its visibility, once the caller confirms the change. */
export async function updateBoard(
  deps: FeedbackAuthoringToolDeps,
  args: UpdateBoardArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openDecision(deps, ctx, args.workspaceId, boardWords);
    if ('content' in opened) {
      return opened;
    }
    const { userId, workspaceId, confirmations } = opened;
    const scope = await resolveFeedbackProject(deps, userId, { workspaceId, projectId: args.projectId });
    const { board } = await deps.feedbackBoards.getBoard(scope, args.boardId);
    const from = { slug: board.slug, name: board.name, isPublic: board.isPublic };
    const to = { slug: args.slug ?? from.slug, name: args.name ?? from.name, isPublic: args.isPublic ?? from.isPublic };
    if (from.slug === to.slug && from.name === to.name && from.isPublic === to.isPublic) {
      return asJson({ changed: false, boardId: board.id, reason: 'The board is like that already.' });
    }
    if (to.slug !== from.slug) {
      await refuseTakenBoardSlug(deps, scope, to.slug, board.id);
    }
    // Bound to the board as it is now: if anyone changes it before the answer, ask again.
    const change = { tool: FEEDBACK_BOARD_UPDATE_TOOL, ...scope, boardId: board.id, from, to };
    const question = [
      `Change the feedback board ${boardLabel(board)}, as you?`,
      ...(from.name === to.name ? [] : [`Name: "${from.name}" → "${to.name}"`]),
      ...(from.slug === to.slug
        ? []
        : [`Address: ${from.slug} → ${to.slug} (its public pages move; links to the old address stop working)`]),
      ...(from.isPublic === to.isPublic
        ? []
        : [`Visibility: ${visibility(from.isPublic)} → ${visibility(to.isPublic)}`]),
    ].join('\n');
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Change this board',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        const updated = await deps.feedbackBoards.updateBoard(scope, board.id, to);
        return asJson({
          changed: true,
          boardId: updated.id,
          slug: updated.slug,
          name: updated.name,
          isPublic: updated.isPublic,
        });
      },
    });
  } catch (error) {
    return feedbackRefusal(error);
  }
}

/** A release policy in the confirmation's words, a line each. */
function policyLines(policy: FeedbackReleasePolicyInput): string[] {
  if (policy.releaseRepoId === null) {
    return ['Shipping on release: off'];
  }
  const steps =
    policy.releaseStepName === null ? 'any release' : `only runs that succeeded the step "${policy.releaseStepName}"`;
  return [
    `Releases of: the project's repo ${policy.releaseRepoId}, ${steps}`,
    `A post ships: ${policy.shipPolicy === ShipPolicies.allLinksShipped ? 'once every issue and pull request it links has shipped' : 'once one issue or pull request it links has shipped'}`,
    `Then: ${policy.shipMode === ShipModes.autoApply ? 'Mocco marks the posts shipped at once, without asking, and their email voters are mailed' : 'the team is asked in the inbox first'}`,
  ];
}

/** Set whose releases ship a board's posts, and how, once the caller confirms the policy. */
export async function setReleasePolicy(
  deps: FeedbackAuthoringToolDeps,
  args: SetReleasePolicyArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openDecision(deps, ctx, args.workspaceId, policyWords);
    if ('content' in opened) {
      return opened;
    }
    const { userId, workspaceId, confirmations } = opened;
    const scope = await resolveFeedbackProject(deps, userId, { workspaceId, projectId: args.projectId });
    const { board } = await deps.feedbackBoards.getBoard(scope, args.boardId);
    const from = policyOf(board);
    const to: FeedbackReleasePolicyInput = {
      releaseRepoId: args.releaseRepoId ?? (args.releaseRepoId === null ? null : from.releaseRepoId),
      releaseStepName: args.releaseStepName ?? (args.releaseStepName === null ? null : from.releaseStepName),
      shipPolicy: args.shipPolicy ?? from.shipPolicy,
      shipMode: args.shipMode ?? from.shipMode,
    };
    if (
      from.releaseRepoId === to.releaseRepoId &&
      from.releaseStepName === to.releaseStepName &&
      from.shipPolicy === to.shipPolicy &&
      from.shipMode === to.shipMode
    ) {
      return asJson({ changed: false, boardId: board.id, reason: 'The board has that release policy already.' });
    }
    const change = { tool: FEEDBACK_RELEASE_POLICY_TOOL, ...scope, boardId: board.id, from, to };
    const question = [
      `Change how releases ship the posts of feedback board ${boardLabel(board)}, as you?`,
      'Now:',
      ...policyLines(from).map(line => `- ${line}`),
      'After:',
      ...policyLines(to).map(line => `- ${line}`),
      'The change is recorded in the audit trail.',
    ].join('\n');
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Change the release policy',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        // The service checks again that the repo is one of the project's.
        const updated = await deps.feedbackBoards.setReleasePolicy(scope, userId, board.id, to);
        return asJson({ changed: true, boardId: updated.id, releasePolicy: policyOf(updated) });
      },
    });
  } catch (error) {
    return feedbackRefusal(error);
  }
}

/** The category on the board, or FeedbackCategoryNotFoundError (another board's or project's too). */
function categoryOn(categories: readonly FeedbackCategoryRow[], categoryId: string): FeedbackCategoryRow {
  const category = categories.find(each => each.id === categoryId);
  if (category === undefined) {
    throw new FeedbackCategoryNotFoundError(categoryId);
  }
  return category;
}

/** A taken category address, refused before asking: another category of the board has it. */
function refuseTakenCategorySlug(categories: readonly FeedbackCategoryRow[], slug: string, categoryId?: string) {
  if (categories.some(category => category.slug === slug && category.id !== categoryId)) {
    throw new FeedbackSlugTakenError('category', slug);
  }
}

/** Add a category to a board, once the caller confirms it. */
export async function createCategory(
  deps: FeedbackAuthoringToolDeps,
  args: CreateCategoryArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openDecision(deps, ctx, args.workspaceId, categoryWords);
    if ('content' in opened) {
      return opened;
    }
    const { userId, workspaceId, confirmations } = opened;
    const scope = await resolveFeedbackProject(deps, userId, { workspaceId, projectId: args.projectId });
    const { board, categories } = await deps.feedbackBoards.getBoard(scope, args.boardId);
    refuseTakenCategorySlug(categories, args.slug);
    const position = args.position ?? null;
    const change = {
      tool: FEEDBACK_CATEGORY_CREATE_TOOL,
      ...scope,
      boardId: board.id,
      slug: args.slug,
      name: args.name,
      position,
    };
    const question = [
      `Add the category "${args.name}" (${args.slug}) to feedback board ${boardLabel(board)}, as you?`,
      position === null ? 'It goes last.' : `Position: ${String(position)}`,
    ].join('\n');
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Add this category',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        const category = await deps.feedbackBoards.createCategory(scope, board.id, {
          slug: args.slug,
          name: args.name,
          ...(position !== null && { position }),
        });
        return asJson({
          created: true,
          categoryId: category.id,
          slug: category.slug,
          name: category.name,
          position: category.position,
        });
      },
    });
  } catch (error) {
    return feedbackRefusal(error);
  }
}

/** Rename a category, move its address or its place, once the caller confirms the change. */
export async function updateCategory(
  deps: FeedbackAuthoringToolDeps,
  args: UpdateCategoryArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openDecision(deps, ctx, args.workspaceId, categoryWords);
    if ('content' in opened) {
      return opened;
    }
    const { userId, workspaceId, confirmations } = opened;
    const scope = await resolveFeedbackProject(deps, userId, { workspaceId, projectId: args.projectId });
    const { board, categories } = await deps.feedbackBoards.getBoard(scope, args.boardId);
    const category = categoryOn(categories, args.categoryId);
    const from = { slug: category.slug, name: category.name, position: category.position };
    const to = {
      slug: args.slug ?? from.slug,
      name: args.name ?? from.name,
      position: args.position ?? from.position,
    };
    if (from.slug === to.slug && from.name === to.name && from.position === to.position) {
      return asJson({ changed: false, categoryId: category.id, reason: 'The category is like that already.' });
    }
    if (to.slug !== from.slug) {
      refuseTakenCategorySlug(categories, to.slug, category.id);
    }
    const change = {
      tool: FEEDBACK_CATEGORY_UPDATE_TOOL,
      ...scope,
      boardId: board.id,
      categoryId: category.id,
      from,
      to,
    };
    const question = [
      `Change the category "${category.name}" of feedback board ${boardLabel(board)}, as you?`,
      ...(from.name === to.name ? [] : [`Name: "${from.name}" → "${to.name}"`]),
      ...(from.slug === to.slug ? [] : [`Address: ${from.slug} → ${to.slug}`]),
      ...(from.position === to.position ? [] : [`Position: ${String(from.position)} → ${String(to.position)}`]),
    ].join('\n');
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Change this category',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        const updated = await deps.feedbackBoards.updateCategory(scope, category.id, to);
        return asJson({
          changed: true,
          categoryId: updated.id,
          slug: updated.slug,
          name: updated.name,
          position: updated.position,
        });
      },
    });
  } catch (error) {
    return feedbackRefusal(error);
  }
}

/** Delete a category, its posts staying on the board uncategorized, once the caller confirms. */
export async function deleteCategory(
  deps: FeedbackAuthoringToolDeps,
  args: DeleteCategoryArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openDecision(deps, ctx, args.workspaceId, categoryWords);
    if ('content' in opened) {
      return opened;
    }
    const { userId, workspaceId, confirmations } = opened;
    const scope = await resolveFeedbackProject(deps, userId, { workspaceId, projectId: args.projectId });
    const { board, categories } = await deps.feedbackBoards.getBoard(scope, args.boardId);
    const category = categoryOn(categories, args.categoryId);
    // How many posts lose it, to say so; at most a page is read, so a full page is "or more".
    const inIt = await deps.feedbackPosts.list(scope, {
      boardId: board.id,
      categoryId: category.id,
      sort: FeedbackPostSorts.newest,
      limit: FeedbackLimits.listMax,
      offset: 0,
    });
    const count = inIt.length === FeedbackLimits.listMax ? `${String(inIt.length)} or more` : String(inIt.length);
    const change = {
      tool: FEEDBACK_CATEGORY_DELETE_TOOL,
      ...scope,
      boardId: board.id,
      categoryId: category.id,
      slug: category.slug,
      name: category.name,
    };
    const question = [
      `Delete the category "${category.name}" (${category.slug}) of feedback board ${boardLabel(board)}, as you?`,
      `Its ${count} ${inIt.length === 1 ? 'post stays' : 'posts stay'} on the board, with no category. Deleting it cannot be undone.`,
    ].join('\n');
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Delete this category',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        await deps.feedbackBoards.deleteCategory(scope, category.id);
        return asJson({ deleted: true, categoryId: category.id });
      },
    });
  } catch (error) {
    return feedbackRefusal(error);
  }
}

/** A category's line in a confirmation. */
const categoryLine = (categories: readonly FeedbackCategoryRow[], categoryId: string | null) =>
  categoryId === null ? 'none' : `"${categoryOn(categories, categoryId).name}"`;

/** Write a post on a board as the caller (the team), once they confirm its words. */
export async function createPost(
  deps: FeedbackAuthoringToolDeps,
  args: CreatePostArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openDecision(deps, ctx, args.workspaceId, postWords);
    if ('content' in opened) {
      return opened;
    }
    const { userId, workspaceId, confirmations } = opened;
    const scope = await resolveFeedbackProject(deps, userId, { workspaceId, projectId: args.projectId });
    const { board, categories } = await deps.feedbackBoards.getBoard(scope, args.boardId);
    const categoryId = args.categoryId ?? null;
    const category = categoryLine(categories, categoryId);
    const status = args.status ?? FeedbackPostStatuses.underReview;
    const body = args.body ?? '';
    const change = {
      tool: FEEDBACK_POST_CREATE_TOOL,
      ...scope,
      boardId: board.id,
      title: args.title,
      body,
      categoryId,
      status,
    };
    const question = [
      `Post "${args.title}" on feedback board ${boardLabel(board)}, as you?`,
      `Category: ${category}`,
      `Status: ${status}`,
      board.isPublic ? 'The board is public, so end users see it.' : 'The board is private.',
      ...(body === '' ? [] : ['', body]),
    ].join('\n');
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Create this post',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        const post = await deps.feedbackPosts.create(scope, userId, {
          boardId: board.id,
          title: args.title,
          body,
          ...(categoryId !== null && { categoryId }),
          status,
        });
        return asJson({
          created: true,
          postId: post.id,
          number: post.number,
          title: post.title,
          status: post.status,
          categoryId: post.categoryId,
        });
      },
    });
  } catch (error) {
    return feedbackRefusal(error);
  }
}

/** A short fingerprint of a body, so a confirmation is bound to it without carrying it. */
const bodyHash = (body: string) => createHash('sha256').update(body).digest('hex').slice(0, 32);

/** Edit a post's title, details or category, once the caller confirms the change. */
export async function updatePost(
  deps: FeedbackAuthoringToolDeps,
  args: UpdatePostArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openDecision(deps, ctx, args.workspaceId, postWords);
    if ('content' in opened) {
      return opened;
    }
    const { userId, workspaceId, confirmations } = opened;
    const scope = await resolveFeedbackProject(deps, userId, { workspaceId, projectId: args.projectId });
    const post = await deps.feedbackPosts.requirePost(scope, args.postId);
    const isTitleChanged = args.title !== undefined && args.title !== post.title;
    const isBodyChanged = args.body !== undefined && args.body !== post.body;
    const isCategoryChanged = args.categoryId !== undefined && args.categoryId !== post.categoryId;
    if (!isTitleChanged && !isBodyChanged && !isCategoryChanged) {
      return asJson({ changed: false, postId: post.id, reason: 'The post says that already.' });
    }
    const { categories } = await deps.feedbackBoards.getBoard(scope, post.boardId);
    const nextCategory = args.categoryId ?? (args.categoryId === null ? null : post.categoryId);
    // Bound to the post's words and category now: an edit by anyone before the answer asks again.
    const change = {
      tool: FEEDBACK_POST_UPDATE_TOOL,
      ...scope,
      postId: post.id,
      from: { title: post.title, body: bodyHash(post.body), categoryId: post.categoryId },
      to: {
        ...(isTitleChanged && { title: args.title }),
        ...(isBodyChanged && { body: args.body }),
        ...(isCategoryChanged && { categoryId: nextCategory }),
      },
    };
    const question = [
      `Edit feedback post ${postLabel(post)}, as you?`,
      ...(isTitleChanged ? [`Title: "${post.title}" → "${args.title ?? ''}"`] : []),
      ...(isCategoryChanged
        ? [`Category: ${categoryLine(categories, post.categoryId)} → ${categoryLine(categories, nextCategory)}`]
        : []),
      ...(isBodyChanged ? ['Details, replacing the old ones:', '', args.body ?? ''] : []),
    ].join('\n');
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Edit this post',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        const updated = await deps.feedbackPosts.update(scope, post.id, {
          ...(isTitleChanged && { title: args.title }),
          ...(isBodyChanged && { body: args.body }),
          ...(isCategoryChanged && { categoryId: nextCategory }),
        });
        return asJson({
          changed: true,
          postId: updated.id,
          number: updated.number,
          title: updated.title,
          categoryId: updated.categoryId,
          updatedAt: updated.updatedAt,
        });
      },
    });
  } catch (error) {
    return feedbackRefusal(error);
  }
}

const challenge = (doing: string) =>
  requireScope(McpScopes.feedbackWrite, `${doing} needs your permission for this app to change your feedback boards`);
const changing = { readOnlyHint: false, openWorldHint: false } as const;
const asked =
  'The person confirms it in their client first, and it only works where the workspace allows agents to make changes.';

export function registerFeedbackAuthoringTools(server: McpServer, deps: FeedbackAuthoringToolDeps): void {
  server.registerTool(
    'mocco_feedback_board_get',
    {
      title: 'Read a feedback board',
      description:
        'One feedback board: its address, name, whether it is public, its release policy (whose releases ship its posts, and whether the team is asked first) and its categories in order. Read-only.',
      inputSchema: boardReadInput,
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => asJson(await getBoard(deps, args, userIdOf(ctx))),
  );

  server.registerTool(
    FEEDBACK_BOARD_CREATE_TOOL,
    {
      title: 'Create a feedback board',
      description: `Create a feedback board in the project, as the signed-in person: its address, name and whether end users see it. ${asked}`,
      inputSchema: boardCreateInput,
      annotations: { ...changing, destructiveHint: false, idempotentHint: false },
      scopeChallenge: challenge('Creating a board'),
    },
    async (args, ctx) => await createBoard(deps, args, ctx),
  );

  server.registerTool(
    FEEDBACK_BOARD_UPDATE_TOOL,
    {
      title: 'Change a feedback board',
      description: `Rename a feedback board, move its address, or make it public or private, as the signed-in person; only the fields given change. ${asked} Deleting a board is done in the console only.`,
      inputSchema: boardUpdateInput,
      annotations: { ...changing, destructiveHint: false, idempotentHint: true },
      scopeChallenge: challenge('Changing a board'),
    },
    async (args, ctx) => await updateBoard(deps, args, ctx),
  );

  server.registerTool(
    FEEDBACK_RELEASE_POLICY_TOOL,
    {
      title: "Set a feedback board's release policy",
      description: `Set which repo's releases ship a feedback board's posts (or none), which release step must have succeeded, when a post counts as shipped, and whether the team is asked first or posts are marked shipped at once; only the fields given change. Audited. ${asked}`,
      inputSchema: policyInput,
      annotations: { ...changing, destructiveHint: false, idempotentHint: true },
      scopeChallenge: challenge("Changing a board's release policy"),
    },
    async (args, ctx) => await setReleasePolicy(deps, args, ctx),
  );

  server.registerTool(
    FEEDBACK_CATEGORY_CREATE_TOOL,
    {
      title: 'Add a feedback category',
      description: `Add a category to a feedback board, as the signed-in person: its address, name and, optionally, its place in the order. ${asked}`,
      inputSchema: categoryCreateInput,
      annotations: { ...changing, destructiveHint: false, idempotentHint: false },
      scopeChallenge: challenge('Adding a category'),
    },
    async (args, ctx) => await createCategory(deps, args, ctx),
  );

  server.registerTool(
    FEEDBACK_CATEGORY_UPDATE_TOOL,
    {
      title: 'Change a feedback category',
      description: `Rename a feedback board's category, move its address or its place in the order, as the signed-in person; only the fields given change. ${asked}`,
      inputSchema: categoryUpdateInput,
      annotations: { ...changing, destructiveHint: false, idempotentHint: true },
      scopeChallenge: challenge('Changing a category'),
    },
    async (args, ctx) => await updateCategory(deps, args, ctx),
  );

  server.registerTool(
    FEEDBACK_CATEGORY_DELETE_TOOL,
    {
      title: 'Delete a feedback category',
      description: `Delete a feedback board's category, as the signed-in person: its posts stay on the board with no category, and it cannot be undone. ${asked}`,
      inputSchema: categoryDeleteInput,
      annotations: { ...changing, destructiveHint: true, idempotentHint: true },
      scopeChallenge: challenge('Deleting a category'),
    },
    async (args, ctx) => await deleteCategory(deps, args, ctx),
  );

  server.registerTool(
    FEEDBACK_POST_CREATE_TOOL,
    {
      title: 'Write a feedback post',
      description: `Post on a feedback board as the signed-in person (the team): a title, details in Markdown, a category and a first status. It gets the board's next number and starts with no votes. ${asked}`,
      inputSchema: postCreateInput,
      annotations: { ...changing, destructiveHint: false, idempotentHint: false },
      scopeChallenge: challenge('Writing a post'),
    },
    async (args, ctx) => await createPost(deps, args, ctx),
  );

  server.registerTool(
    FEEDBACK_POST_UPDATE_TOOL,
    {
      title: 'Edit a feedback post',
      description: `Edit a feedback post's title, details or category as the signed-in person; only the fields given change, and \`categoryId: null\` takes it out of its category. Its status moves with \`mocco_feedback_post_set_status\`. ${asked}`,
      inputSchema: postUpdateInput,
      annotations: { ...changing, destructiveHint: false, idempotentHint: true },
      scopeChallenge: challenge('Editing a post'),
    },
    async (args, ctx) => await updatePost(deps, args, ctx),
  );
}
