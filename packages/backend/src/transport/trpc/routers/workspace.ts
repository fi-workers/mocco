// Workspace domain router — thin by convention: parse at the boundary (zod
// from @mocco/common), delegate to the injected service. This domain maps its
// own errors here (not centrally), via a router-scoped middleware, so the
// transport core stays free of any specific domain's error knowledge.
import {
  workspaceCreateInputSchema,
  workspaceMemberDetailSchema,
  workspaceMemberSchema,
  workspaceSchema,
} from '@mocco/common/workspace';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { NotFoundError } from '#backend/domain/errors';
import { router, protectedProcedure } from '#backend/transport/trpc/trpc';

// The service throws WorkspaceNotFoundError (a NotFoundError) when a workspace is
// missing or isn't the caller's; surface that as NOT_FOUND. Declared here — and
// reused across the router's procedures (update, members) — rather than in the
// transport core, so error→code mapping lives with the domain that owns it.
const protectedWorkspaceProcedure = protectedProcedure.use(async ({ next }) => {
  const result = await next();
  if (!result.ok && result.error.cause instanceof NotFoundError) {
    throw new TRPCError({ code: 'NOT_FOUND', message: result.error.cause.message, cause: result.error.cause });
  }
  return result;
});

export const workspaceRouter = router({
  list: protectedWorkspaceProcedure
    .output(z.object({ workspaces: z.array(workspaceSchema) }))
    .query(async ({ ctx }) => ({ workspaces: await ctx.workspace.list(ctx.headers) })),

  active: protectedWorkspaceProcedure
    .output(z.object({ workspace: workspaceSchema.extend({ members: z.array(workspaceMemberSchema) }).nullable() }))
    .query(async ({ ctx }) => ({ workspace: await ctx.workspace.getActive(ctx.headers) })),

  create: protectedWorkspaceProcedure
    .input(workspaceCreateInputSchema)
    .output(z.object({ workspace: workspaceSchema }))
    .mutation(async ({ ctx, input }) => ({ workspace: await ctx.workspace.create(ctx.headers, input) })),

  setActive: protectedWorkspaceProcedure.input(z.object({ workspaceId: z.uuid() })).mutation(async ({ ctx, input }) => {
    await ctx.workspace.setActive(ctx.headers, input.workspaceId);
    return { ok: true } as const;
  }),

  update: protectedWorkspaceProcedure
    .input(workspaceCreateInputSchema.extend({ workspaceId: z.uuid() }))
    .output(z.object({ workspace: workspaceSchema }))
    .mutation(async ({ ctx, input }) => ({
      workspace: await ctx.workspace.update(ctx.headers, input.workspaceId, { name: input.name }),
    })),

  delete: protectedWorkspaceProcedure.input(z.object({ workspaceId: z.uuid() })).mutation(async ({ ctx, input }) => {
    await ctx.workspace.delete(ctx.headers, input.workspaceId);
    return { ok: true } as const;
  }),

  members: protectedWorkspaceProcedure
    .input(z.object({ workspaceId: z.uuid() }))
    .output(z.object({ members: z.array(workspaceMemberDetailSchema) }))
    .query(async ({ ctx, input }) => ({ members: await ctx.workspace.listMembers(ctx.headers, input.workspaceId) })),
});
