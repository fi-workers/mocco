import { workspaceCreateInputSchema, workspaceMemberSchema, workspaceSchema } from '@mocco/common/workspace';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { router, publicProcedure, protectedProcedure } from './trpc';

export const appRouter = router({
  health: publicProcedure.query(() => ({ ok: true })),

  workspace: router({
    list: protectedProcedure
      .output(z.array(workspaceSchema))
      .query(async ({ ctx }) => await ctx.workspace.list(ctx.headers)),

    active: protectedProcedure
      .output(workspaceSchema.extend({ members: z.array(workspaceMemberSchema) }).nullable())
      .query(async ({ ctx }) => await ctx.workspace.getActive(ctx.headers)),

    create: protectedProcedure
      .input(workspaceCreateInputSchema)
      .output(workspaceSchema)
      .mutation(async ({ ctx, input }) => {
        try {
          return await ctx.workspace.create(ctx.headers, input);
        } catch (error) {
          // Map ONLY duplicate-slug rejections; anything else re-throws untouched.
          // Two sources: the vendor's exact-match pre-check (BAD_REQUEST "already
          // exists"), and the DB's case-insensitive lower(slug) unique index
          // (concurrent / case-variant races surface as a pg unique violation).
          const { status } = error as { status?: string };
          const { message } = error as Error;
          const causeText = (error as { cause?: { message?: string } }).cause?.message;
          if (
            (status === 'BAD_REQUEST' && /already exists/i.test(message)) ||
            (causeText?.includes('mocco_workspaces_slug_lower_uq') ?? false)
          ) {
            throw new TRPCError({ code: 'CONFLICT', message: 'That slug is already taken.' });
          }
          throw error;
        }
      }),

    setActive: protectedProcedure.input(z.object({ workspaceId: z.uuid() })).mutation(async ({ ctx, input }) => {
      await ctx.workspace.setActive(ctx.headers, input.workspaceId);
      return { ok: true } as const;
    }),
  }),
});

export type AppRouter = typeof appRouter;
