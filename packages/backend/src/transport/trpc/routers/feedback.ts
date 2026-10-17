// Feedback router (#172): a project's boards, categories and posts, moving posts through
// statuses, and their votes, comments, subscribers and merges (#173). Every procedure requires the
// feedback product to be enabled and the project to belong to the workspace (`productProcedure`,
// which asserts membership), and the same chain maps the domain's error families
// (FeedbackBoardNotFoundError and the other not-founds → NOT_FOUND; FeedbackSlugTakenError,
// FeedbackStatusUnchangedError and FeedbackPostMergedError → CONFLICT;
// FeedbackOfficialInternalError and FeedbackMergeInvalidError → BAD_REQUEST). Entities are looked up within the
// caller's workspace and project, so another tenant's id is NOT_FOUND.
import {
  FEEDBACK_LINK_SEARCH_LIMIT,
  FeedbackLimits,
  FeedbackVoteSources,
  feedbackBoardInputSchema,
  feedbackCategoryInputSchema,
  feedbackCommentInputSchema,
  feedbackConvertInputSchema,
  feedbackEndUserIdSchema,
  feedbackLinkCreateInputSchema,
  feedbackLinkSearchInputSchema,
  feedbackPageInputSchema,
  feedbackPostCreateInputSchema,
  feedbackPostListInputSchema,
  feedbackPostStatusSchema,
  feedbackPostUpdateInputSchema,
  feedbackSourceTypeSchema,
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

  /** The post's votes, newest first, pending ones included. */
  votes: feedbackProcedure.input(postInput.extend(feedbackPageInputSchema.shape)).query(async ({ ctx, input }) => ({
    votes: await ctx.feedbackVotes.list(scopeOf(input), input.postId, { limit: input.limit, offset: input.offset }),
  })),

  /** Record an end user's vote on their behalf (a customer asked by email, on a call…); it counts
   * at once. Voting again is a no-op. */
  vote: feedbackProcedure.input(postInput.extend({ endUserId: feedbackEndUserIdSchema })).mutation(
    async ({ ctx, input }) =>
      await ctx.feedbackVotes.vote(scopeOf(input), input.postId, input.endUserId, {
        source: FeedbackVoteSources.staff,
        recordedByUserId: ctx.session.user.id,
      }),
  ),

  /** Take an end user's vote back; no vote is no change. */
  unvote: feedbackProcedure
    .input(postInput.extend({ endUserId: feedbackEndUserIdSchema }))
    .mutation(async ({ ctx, input }) => ({
      post: await ctx.feedbackVotes.unvote(scopeOf(input), input.postId, input.endUserId),
    })),

  /** The post's current subscribers, oldest first (voters subscribe unless they opted out). */
  subscribers: feedbackProcedure
    .input(postInput.extend(feedbackPageInputSchema.shape))
    .query(async ({ ctx, input }) => ({
      subscribers: await ctx.feedbackSubscriptions.list(scopeOf(input), input.postId, {
        limit: input.limit,
        offset: input.offset,
      }),
    })),

  /** Merge the post (a duplicate) into another on its board: its votes and subscribers move
   * there, one per end user, and it is closed. */
  mergePost: feedbackProcedure
    .input(postInput.extend({ intoPostId: z.uuid() }))
    .mutation(
      async ({ ctx, input }) =>
        await ctx.feedbackMerges.merge(scopeOf(input), ctx.session.user.id, input.postId, input.intoPostId),
    ),

  /** The board's suggested duplicate pairs still to decide, the newest first, with both posts,
   * and how many there are. Merge one with `mergePost` (post into original). */
  duplicates: feedbackProcedure
    .input(boardInput.extend({ limit: z.int().min(1).max(FeedbackLimits.listMax).default(FeedbackLimits.listDefault) }))
    .query(async ({ ctx, input }) => {
      const pairs = await ctx.feedbackDuplicates.list(scopeOf(input), input.boardId, input.limit);
      return {
        pairs: pairs.map(pair => ({
          id: pair.candidate.id,
          score: pair.candidate.score,
          method: pair.candidate.method,
          createdAt: pair.candidate.createdAt,
          post: pair.post,
          original: pair.original,
        })),
        openCount: await ctx.feedbackDuplicates.countOpen(scopeOf(input), input.boardId),
      };
    }),

  /** Set a suggested pair aside: the posts aren't the same request, and it isn't suggested again. */
  dismissDuplicate: feedbackProcedure
    .input(projectInput.extend({ duplicateId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.feedbackDuplicates.dismiss(scopeOf(input), ctx.session.user.id, input.duplicateId);
      return { ok: true } as const;
    }),

  /** What converting a source (a messenger conversation) on the board would start from: a title
   * and details from the request, the board's posts it may repeat, and the posts it already became. */
  intakePreview: feedbackProcedure
    .input(boardInput.extend({ sourceType: feedbackSourceTypeSchema, sourceId: z.string().min(1).max(200) }))
    .query(
      async ({ ctx, input }) =>
        await ctx.feedbackIntake.preview(scopeOf(input), input.sourceType, input.sourceId, input.boardId),
    ),

  /** Make the source a new post on a board, or add it to `intoPostId`; its requester votes when known.
   * A source that already became a post answers that post. */
  convertSource: feedbackProcedure.input(projectInput.and(feedbackConvertInputSchema)).mutation(
    async ({ ctx, input }) =>
      await ctx.feedbackIntake.convert(scopeOf(input), ctx.session.user.id, {
        ...('intoPostId' in input
          ? { intoPostId: input.intoPostId }
          : { boardId: input.boardId, title: input.title, ...(input.body !== undefined && { body: input.body }) }),
        sourceType: input.sourceType,
        sourceId: input.sourceId,
      }),
  ),

  /** The posts a source became, for its own page. */
  sourcePosts: feedbackProcedure
    .input(projectInput.extend({ sourceType: feedbackSourceTypeSchema, sourceId: z.string().min(1).max(200) }))
    .query(async ({ ctx, input }) => {
      const links = await ctx.feedbackIntake.postsOf(scopeOf(input), input.sourceType, input.sourceId);
      return { posts: links.map(link => link.post) };
    }),

  /** Where a post came from, with the request's words (staff only). */
  postSources: feedbackProcedure.input(postInput).query(async ({ ctx, input }) => {
    await ctx.feedbackPosts.requirePost(scopeOf(input), input.postId);
    return { sources: await ctx.feedbackIntake.sourcesOf(scopeOf(input), input.postId) };
  }),

  /** The repos linked to the project, whose issues and pull requests a post can link (#178). */
  linkRepos: feedbackProcedure.input(projectInput).query(async ({ ctx, input }) => ({
    repos: await ctx.feedbackLinks.repos(scopeOf(input)),
  })),

  /** Search one of the project's repos for issues or pull requests (words, or a number). */
  linkSearch: feedbackProcedure
    .input(projectInput.extend(feedbackLinkSearchInputSchema.shape))
    .query(async ({ ctx, input }) => ({
      items: await ctx.feedbackLinks.search(
        scopeOf(input),
        { repoId: input.repoId, kind: input.kind, query: input.query },
        FEEDBACK_LINK_SEARCH_LIMIT,
      ),
    })),

  /** The post's GitHub links, with their state and an issue's closing pull requests. */
  links: feedbackProcedure.input(postInput).query(async ({ ctx, input }) => ({
    links: await ctx.feedbackLinks.list(scopeOf(input), input.postId),
  })),

  /** Link an issue or pull request of one of the project's repos to the post. */
  link: feedbackProcedure
    .input(postInput.extend(feedbackLinkCreateInputSchema.shape))
    .mutation(async ({ ctx, input }) => ({
      link: await ctx.feedbackLinks.link(scopeOf(input), ctx.session.user.id, input.postId, {
        repoId: input.repoId,
        kind: input.kind,
        number: input.number,
      }),
    })),

  /** Remove one of the project's links. */
  unlink: feedbackProcedure.input(projectInput.extend({ linkId: z.uuid() })).mutation(async ({ ctx, input }) => {
    await ctx.feedbackLinks.unlink(scopeOf(input), ctx.session.user.id, input.linkId);
    return { ok: true } as const;
  }),

  /** The post's comments, oldest first, internal notes included. */
  comments: feedbackProcedure.input(postInput.extend(feedbackPageInputSchema.shape)).query(async ({ ctx, input }) => ({
    comments: await ctx.feedbackComments.listForStaff(scopeOf(input), input.postId, {
      limit: input.limit,
      offset: input.offset,
    }),
  })),

  /** Comment as the caller: plainly, as the official response, or as an internal note. */
  createComment: feedbackProcedure
    .input(postInput.extend(feedbackCommentInputSchema.shape))
    .mutation(async ({ ctx, input }) => ({
      comment: await ctx.feedbackComments.createAsStaff(scopeOf(input), ctx.session.user.id, input.postId, {
        body: input.body,
        isOfficial: input.isOfficial,
        isInternal: input.isInternal,
      }),
    })),
});
