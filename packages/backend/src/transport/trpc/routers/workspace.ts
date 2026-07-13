// Workspace domain router — thin by convention: parse at the boundary (zod
// from @mocco/common), delegate to the injected service. Domain errors (e.g.
// WorkspaceNotFoundError) are mapped to transport codes centrally by the
// mapDomainErrors middleware in trpc.ts, so procedures stay plumbing-free.
import {
  workspaceCreateInputSchema,
  workspaceMemberDetailSchema,
  workspaceMemberSchema,
  workspaceSchema,
} from '@mocco/common/workspace';
import { z } from 'zod';

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
    .mutation(async ({ ctx, input }) => ({
      workspace: await ctx.workspace.update(ctx.headers, input.workspaceId, { name: input.name }),
    })),

  delete: protectedProcedure.input(z.object({ workspaceId: z.uuid() })).mutation(async ({ ctx, input }) => {
    await ctx.workspace.delete(ctx.headers, input.workspaceId);
    return { ok: true } as const;
  }),

  members: protectedProcedure
    .input(z.object({ workspaceId: z.uuid() }))
    .output(z.object({ members: z.array(workspaceMemberDetailSchema) }))
    .query(async ({ ctx, input }) => ({ members: await ctx.workspace.listMembers(ctx.headers, input.workspaceId) })),
});
