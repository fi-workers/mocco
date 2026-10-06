// Feedback router (#172): a project's boards, categories and posts, and moving posts through
// statuses. Every procedure requires the feedback product to be enabled and the project to belong
// to the workspace (`productProcedure`, which asserts membership), and the same chain maps the
// domain's error families (FeedbackBoardNotFoundError and the other not-founds → NOT_FOUND,
// FeedbackSlugTakenError and FeedbackStatusUnchangedError → CONFLICT). Entities are looked up
// within the caller's workspace and project, so another tenant's id is NOT_FOUND.
import {
  feedbackBoardInputSchema,
  feedbackCategoryInputSchema,
  feedbackPostCreateInputSchema,
  feedbackPostListInputSchema,
  feedbackPostStatusSchema,
  feedbackPostUpdateInputSchema,
} from '@mocco/common/feedback';
import { Products } from '@mocco/common/project';
import { z } from 'zod';

import { productProcedure } from '@backend/transport/trpc/project-procedures';
import { router } from '@backend/transport/trpc/trpc';

const projectInput = z.object({ workspaceId: z.uuid(), projectId: z.uuid() });
const boardInput = projectInput.extend({ boardId: z.uuid() });
const categoryInput = projectInput.extend({ categoryId: z.uuid() });
const postInput = projectInput.extend({ postId: z.uuid() });
const feedbackProcedure = productProcedure(Products.feedback);

const scopeOf = (input: { workspaceId: string; projectId: string }) => ({
  workspaceId: input.workspaceId,
  projectId: input.projectId,
});

export const feedbackRouter = router({
  boards: feedbackProcedure.input(projectInput).query(async ({ ctx, input }) => ({
    boards: await ctx.feedbackBoards.listBoards(scopeOf(input)),
  })),

  /** The board with its categories in order. */
  board: feedbackProcedure
    .input(boardInput)
    .query(async ({ ctx, input }) => await ctx.feedbackBoards.getBoard(scopeOf(input), input.boardId)),

  createBoard: feedbackProcedure
    .input(projectInput.extend(feedbackBoardInputSchema.shape))
    .mutation(async ({ ctx, input }) => ({
      board: await ctx.feedbackBoards.createBoard(scopeOf(input), ctx.session.user.id, {
        slug: input.slug,
        name: input.name,
        ...(input.isPublic !== undefined && { isPublic: input.isPublic }),
      }),
    })),

  updateBoard: feedbackProcedure
    .input(boardInput.extend(feedbackBoardInputSchema.shape))
    .mutation(async ({ ctx, input }) => ({
      board: await ctx.feedbackBoards.updateBoard(scopeOf(input), input.boardId, {
        slug: input.slug,
        name: input.name,
        ...(input.isPublic !== undefined && { isPublic: input.isPublic }),
      }),
    })),

  /** Delete the board with its categories, posts and their history. */
  deleteBoard: feedbackProcedure.input(boardInput).mutation(async ({ ctx, input }) => {
    await ctx.feedbackBoards.deleteBoard(scopeOf(input), ctx.session.user.id, input.boardId);
    return { ok: true } as const;
  }),

  createCategory: feedbackProcedure
    .input(boardInput.extend(feedbackCategoryInputSchema.shape))
    .mutation(async ({ ctx, input }) => ({
      category: await ctx.feedbackBoards.createCategory(scopeOf(input), input.boardId, {
        slug: input.slug,
        name: input.name,
        ...(input.position !== undefined && { position: input.position }),
      }),
    })),

  updateCategory: feedbackProcedure
    .input(categoryInput.extend(feedbackCategoryInputSchema.shape))
    .mutation(async ({ ctx, input }) => ({
      category: await ctx.feedbackBoards.updateCategory(scopeOf(input), input.categoryId, {
        slug: input.slug,
        name: input.name,
        ...(input.position !== undefined && { position: input.position }),
      }),
    })),

  /** Delete the category; its posts stay on the board, uncategorized. */
  deleteCategory: feedbackProcedure.input(categoryInput).mutation(async ({ ctx, input }) => {
    await ctx.feedbackBoards.deleteCategory(scopeOf(input), input.categoryId);
    return { ok: true } as const;
  }),

  /** A board's posts, by status (workflow order, newest first within one) or newest first. */
  posts: feedbackProcedure
    .input(projectInput.extend(feedbackPostListInputSchema.shape))
    .query(async ({ ctx, input }) => ({
      posts: await ctx.feedbackPosts.list(scopeOf(input), {
        boardId: input.boardId,
        sort: input.sort,
        limit: input.limit,
        offset: input.offset,
        ...(input.status !== undefined && { status: input.status }),
        ...(input.categoryId !== undefined && { categoryId: input.categoryId }),
      }),
    })),

  /** The post with its status history, oldest first. */
  post: feedbackProcedure
    .input(postInput)
    .query(async ({ ctx, input }) => await ctx.feedbackPosts.get(scopeOf(input), input.postId)),

  createPost: feedbackProcedure
    .input(projectInput.extend(feedbackPostCreateInputSchema.shape))
    .mutation(async ({ ctx, input }) => ({
      post: await ctx.feedbackPosts.create(scopeOf(input), ctx.session.user.id, {
        boardId: input.boardId,
        title: input.title,
        ...(input.body !== undefined && { body: input.body }),
        ...(input.categoryId !== undefined && { categoryId: input.categoryId }),
        ...(input.status !== undefined && { status: input.status }),
      }),
    })),

  updatePost: feedbackProcedure
    .input(postInput.extend(feedbackPostUpdateInputSchema.shape))
    .mutation(async ({ ctx, input }) => ({
      post: await ctx.feedbackPosts.update(scopeOf(input), input.postId, {
        ...(input.title !== undefined && { title: input.title }),
        ...(input.body !== undefined && { body: input.body }),
        ...(input.categoryId !== undefined && { categoryId: input.categoryId }),
      }),
    })),

  /** Move the post to another status (recorded in its history and the audit log); the same
   * status again is CONFLICT. */
  setPostStatus: feedbackProcedure
    .input(postInput.extend({ status: feedbackPostStatusSchema }))
    .mutation(
      async ({ ctx, input }) =>
        await ctx.feedbackPosts.setStatus(scopeOf(input), ctx.session.user.id, input.postId, input.status),
    ),
});
