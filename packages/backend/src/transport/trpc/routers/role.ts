// Governance/role domain router — thin: parse at the boundary (zod DTOs from
// @mocco/common), delegate to the injected RoleService, and map this domain's
// errors here (NotFoundError -> NOT_FOUND) via a router-scoped middleware. Like the
// run router, `ctx.roles` is always present (the governance domain has no external
// dependency to gate on), so there is no "not configured" branch.
import { roleCreateInputSchema, roleMemberSchema, roleSchema } from '@mocco/common/governance';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { NotFoundError } from '@backend/domain/errors';
import { protectedProcedure, router } from '@backend/transport/trpc/trpc';

// Every role procedure is workspace-scoped and takes `workspaceId` in its input;
// this is the seam that authorizes the caller against it.
const workspaceScopedInput = z.object({ workspaceId: z.uuid() });

// Re-raise a NotFoundError-family cause as NOT_FOUND; a no-op for anything else.
// Shared by the pre-next() assertMember catch (which throws WorkspaceNotFoundError)
// and the post-next() result branch (which sees RoleNotFoundError from RoleService).
const rethrowMappedDomainError = (cause: unknown): void => {
  if (cause instanceof NotFoundError) {
    throw new TRPCError({ code: 'NOT_FOUND', message: cause.message, cause });
  }
};

// Authorizes the caller against the workspaceId they passed, then maps this
// domain's error family — mirrors the run router's protectedRunProcedure.
const protectedRoleProcedure = protectedProcedure.use(async ({ ctx, getRawInput, next }) => {
  // Authorize BEFORE any resolver touches the workspaceId: scoping DB queries by a
  // caller-supplied workspaceId is not isolation unless the caller is proven a
  // member of it. assertMember throws WorkspaceNotFoundError (a NotFoundError) for a
  // non-member, which we surface as NOT_FOUND.
  const { workspaceId } = workspaceScopedInput.parse(await getRawInput());
  try {
    await ctx.workspace.assertMember(ctx.headers, workspaceId);
  } catch (error) {
    rethrowMappedDomainError(error);
    throw error;
  }
  const result = await next();
  if (!result.ok) {
    rethrowMappedDomainError(result.error.cause);
  }
  return result;
});

export const roleRouter = router({
  create: protectedRoleProcedure
    .input(workspaceScopedInput.extend(roleCreateInputSchema.shape))
    .output(z.object({ role: roleSchema }))
    .mutation(async ({ ctx, input }) => ({ role: await ctx.roles.create(input.workspaceId, input.name) })),

  list: protectedRoleProcedure
    .input(workspaceScopedInput)
    .output(z.object({ roles: z.array(roleSchema) }))
    .query(async ({ ctx, input }) => ({ roles: await ctx.roles.list(input.workspaceId) })),

  delete: protectedRoleProcedure
    .input(workspaceScopedInput.extend({ roleId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.roles.delete(input.workspaceId, input.roleId);
      return { ok: true } as const;
    }),

  listMembers: protectedRoleProcedure
    .input(workspaceScopedInput.extend({ roleId: z.uuid() }))
    .output(z.object({ members: z.array(roleMemberSchema) }))
    .query(async ({ ctx, input }) => ({ members: await ctx.roles.listMembers(input.workspaceId, input.roleId) })),

  addMember: protectedRoleProcedure
    .input(workspaceScopedInput.extend({ roleId: z.uuid(), userId: z.uuid() }))
    .output(z.object({ member: roleMemberSchema.pick({ id: true, roleId: true, userId: true, createdAt: true }) }))
    .mutation(async ({ ctx, input }) => ({
      member: await ctx.roles.addMember(input.workspaceId, input.roleId, input.userId),
    })),

  removeMember: protectedRoleProcedure
    .input(workspaceScopedInput.extend({ roleId: z.uuid(), userId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.roles.removeMember(input.workspaceId, input.roleId, input.userId);
      return { ok: true } as const;
    }),
});
