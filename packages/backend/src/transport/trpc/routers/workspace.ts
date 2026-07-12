// Workspace domain router — thin by convention: parse at the boundary (zod
// from @mocco/common), delegate to the injected service, map domain errors.
import { workspaceCreateInputSchema, workspaceMemberSchema, workspaceSchema } from '@mocco/common/workspace';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { WorkspaceNotFoundError } from '../../../domain/auth/errors';
import { router, protectedProcedure } from '../trpc';

export const workspaceRouter = router({
  list: protectedProcedure
    .output(z.object({ workspaces: z.array(workspaceSchema) }))
    .query(async ({ ctx }) => ({ workspaces: await ctx.workspace.list(ctx.headers) })),

  active: protectedProcedure
    .output(z.object({ workspace: workspaceSchema.extend({ members: z.array(workspaceMemberSchema) }).nullable() }))
    .query(async ({ ctx }) => ({ workspace: await ctx.workspace.getActive(ctx.headers) })),

  create: protectedProcedure
    .input(workspaceCreateInputSchema)
    .output(z.object({ workspace: workspaceSchema }))
    .mutation(async ({ ctx, input }) => ({ workspace: await ctx.workspace.create(ctx.headers, input) })),

  setActive: protectedProcedure.input(z.object({ workspaceId: z.uuid() })).mutation(async ({ ctx, input }) => {
    await ctx.workspace.setActive(ctx.headers, input.workspaceId);
    return { ok: true } as const;
  }),

  update: protectedProcedure
    .input(workspaceCreateInputSchema.extend({ workspaceId: z.uuid() }))
    .output(z.object({ workspace: workspaceSchema }))
    .mutation(async ({ ctx, input }) => {
      try {
        return { workspace: await ctx.workspace.update(ctx.headers, input.workspaceId, { name: input.name }) };
      } catch (error) {
        if (error instanceof WorkspaceNotFoundError) {
          throw new TRPCError({ code: 'NOT_FOUND', message: error.message, cause: error });
        }
        throw error;
      }
    }),

  delete: protectedProcedure.input(z.object({ workspaceId: z.uuid() })).mutation(async ({ ctx, input }) => {
    await ctx.workspace.delete(ctx.headers, input.workspaceId);
    return { ok: true } as const;
  }),
});
