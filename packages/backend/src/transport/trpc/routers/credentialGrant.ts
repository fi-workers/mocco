// Credential-broker allowlist router — thin: parse at the boundary (zod DTOs from
// @mocco/common), delegate to the injected GrantService, and map this domain's
// errors here (NotFoundError -> NOT_FOUND) via a router-scoped middleware. Like the
// role/run routers, `ctx.grants` is always present (the credential domain has no
// external dependency to gate on), so there is no "not configured" branch.
import { credentialGrantCreateInputSchema, credentialGrantSchema } from '@mocco/common/credential';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { NotFoundError } from '@backend/domain/errors';
import { protectedProcedure, router } from '@backend/transport/trpc/trpc';

// Every grant procedure is workspace-scoped and takes `workspaceId` in its input;
// this is the seam that authorizes the caller against it.
const workspaceScopedInput = z.object({ workspaceId: z.uuid() });

// Re-raise a NotFoundError-family cause as NOT_FOUND; a no-op for anything else.
// Shared by the pre-next() assertMember catch (WorkspaceNotFoundError) and the
// post-next() result branch (CredentialGrantNotFoundError from GrantService).
const rethrowMappedDomainError = (cause: unknown): void => {
  if (cause instanceof NotFoundError) {
    throw new TRPCError({ code: 'NOT_FOUND', message: cause.message, cause });
  }
};

// Authorizes the caller against the workspaceId they passed, then maps this
// domain's error family — mirrors the role router's protectedRoleProcedure.
const protectedGrantProcedure = protectedProcedure.use(async ({ ctx, getRawInput, next }) => {
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

export const credentialGrantRouter = router({
  create: protectedGrantProcedure
    .input(workspaceScopedInput.extend(credentialGrantCreateInputSchema.shape))
    .output(z.object({ grant: credentialGrantSchema }))
    .mutation(async ({ ctx, input }) => {
      const { workspaceId, ...grant } = input;
      return { grant: await ctx.grants.create(workspaceId, grant) };
    }),

  list: protectedGrantProcedure
    .input(workspaceScopedInput)
    .output(z.object({ grants: z.array(credentialGrantSchema) }))
    .query(async ({ ctx, input }) => ({ grants: await ctx.grants.list(input.workspaceId) })),

  delete: protectedGrantProcedure
    .input(workspaceScopedInput.extend({ grantId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.grants.delete(input.workspaceId, input.grantId);
      return { ok: true } as const;
    }),
});
