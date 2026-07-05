// Workspace domain router — thin by convention: parse at the boundary (zod
// from @mocco/common), delegate to the injected service, map domain errors.
import { workspaceCreateInputSchema, workspaceMemberSchema, workspaceSchema } from '@mocco/common/workspace';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { SlugTakenError } from '../../auth/errors';
import { router, protectedProcedure } from '../trpc';

export const workspaceRouter = router({
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
        // Domain error → transport code; anything else re-throws untouched.
        if (error instanceof SlugTakenError) {
          throw new TRPCError({ code: 'CONFLICT', message: 'That slug is already taken.', cause: error });
        }
        throw error;
      }
    }),

  setActive: protectedProcedure.input(z.object({ workspaceId: z.uuid() })).mutation(async ({ ctx, input }) => {
    await ctx.workspace.setActive(ctx.headers, input.workspaceId);
    return { ok: true } as const;
  }),
});
