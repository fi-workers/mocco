// Changelog router (#176): a board's entries — drafts, scheduled and published — and moving them
// between those states. Like the feedback router, every procedure needs the feedback product on
// and the project in the caller's workspace (`productProcedure`); entries are looked up within it,
// so another tenant's id is NOT_FOUND. ChangelogEntryNotFoundError is NOT_FOUND,
// ChangelogEntryStateError and a taken slug CONFLICT, ChangelogPublishAtPastError and
// ChangelogPostsInvalidError BAD_REQUEST.
import {
  changelogEntryCreateInputSchema,
  changelogEntryListInputSchema,
  changelogEntryUpdateInputSchema,
} from '@mocco/common/feedback';
import { Products } from '@mocco/common/project';
import { z } from 'zod';

import { productProcedure } from '@backend/transport/trpc/project-procedures';
import { router } from '@backend/transport/trpc/trpc';

const projectInput = z.object({ workspaceId: z.uuid(), projectId: z.uuid() });
const entryInput = projectInput.extend({ entryId: z.uuid() });
const changelogProcedure = productProcedure(Products.feedback);

const scopeOf = (input: { workspaceId: string; projectId: string }) => ({
  workspaceId: input.workspaceId,
  projectId: input.projectId,
});

export const changelogRouter = router({
  /** A board's entries, newest first (published, scheduled or edited), optionally in one state. */
  entries: changelogProcedure
    .input(projectInput.extend(changelogEntryListInputSchema.shape))
    .query(async ({ ctx, input }) => ({
      entries: await ctx.feedbackChangelog.list(scopeOf(input), {
        boardId: input.boardId,
        limit: input.limit,
        offset: input.offset,
        ...(input.state !== undefined && { state: input.state }),
      }),
    })),

  entry: changelogProcedure
    .input(entryInput)
    .query(async ({ ctx, input }) => ({ entry: await ctx.feedbackChangelog.get(scopeOf(input), input.entryId) })),

  create: changelogProcedure
    .input(projectInput.extend(changelogEntryCreateInputSchema.shape))
    .mutation(async ({ ctx, input }) => ({
      entry: await ctx.feedbackChangelog.create(scopeOf(input), ctx.session.user.id, {
        boardId: input.boardId,
        title: input.title,
        ...(input.body !== undefined && { body: input.body }),
        ...(input.slug !== undefined && { slug: input.slug }),
        ...(input.tags !== undefined && { tags: input.tags }),
        ...(input.postIds !== undefined && { postIds: input.postIds }),
      }),
    })),

  update: changelogProcedure
    .input(entryInput.extend(changelogEntryUpdateInputSchema.shape))
    .mutation(async ({ ctx, input }) => ({
      entry: await ctx.feedbackChangelog.update(scopeOf(input), input.entryId, {
        ...(input.title !== undefined && { title: input.title }),
        ...(input.body !== undefined && { body: input.body }),
        ...(input.slug !== undefined && { slug: input.slug }),
        ...(input.tags !== undefined && { tags: input.tags }),
        ...(input.postIds !== undefined && { postIds: input.postIds }),
      }),
    })),

  /** Publish now (audited). */
  publish: changelogProcedure.input(entryInput).mutation(async ({ ctx, input }) => ({
    entry: await ctx.feedbackChangelog.publish(scopeOf(input), ctx.session.user.id, input.entryId),
  })),

  /** Publish at `publishAt` (ahead); the publish job does it within a minute of that time. */
  schedule: changelogProcedure
    .input(entryInput.extend({ publishAt: z.coerce.date() }))
    .mutation(async ({ ctx, input }) => ({
      entry: await ctx.feedbackChangelog.schedule(scopeOf(input), input.entryId, input.publishAt),
    })),

  /** Back to a draft, off the public pages (audited when it was published). */
  unpublish: changelogProcedure.input(entryInput).mutation(async ({ ctx, input }) => ({
    entry: await ctx.feedbackChangelog.unpublish(scopeOf(input), ctx.session.user.id, input.entryId),
  })),

  delete: changelogProcedure.input(entryInput).mutation(async ({ ctx, input }) => {
    await ctx.feedbackChangelog.delete(scopeOf(input), ctx.session.user.id, input.entryId);
    return { ok: true } as const;
  }),
});
