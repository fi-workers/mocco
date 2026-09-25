// Reusable procedures for project-scoped routers (ADR 0013). Every product line after
// deploy governance scopes its data to a project, so its router composes these instead
// of re-implementing the tenant checks: `protectedProjectProcedure` proves the caller
// is a member of `workspaceId` AND that `projectId` belongs to it; `productProcedure`
// additionally requires the product to be enabled in the workspace. The project
// domain's own error family is mapped here, next to the checks that raise it —
// trpc.ts stays generic. A product router still maps its own domain's errors.
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '@backend/domain/errors';
import { protectedProcedure } from '@backend/transport/trpc/trpc';

import type { Product } from '@mocco/common/project';

const workspaceScopedInput = z.object({ workspaceId: z.uuid() });
const projectScopedInput = workspaceScopedInput.extend({ projectId: z.uuid() });

/** Re-raise a project-domain error family as its tRPC code; a no-op for anything else. */
export const rethrowProjectDomainError = (cause: unknown): void => {
  if (cause instanceof NotFoundError) {
    throw new TRPCError({ code: 'NOT_FOUND', message: cause.message, cause });
  }
  if (cause instanceof ConflictError) {
    throw new TRPCError({ code: 'CONFLICT', message: cause.message, cause });
  }
  if (cause instanceof ForbiddenError) {
    throw new TRPCError({ code: 'FORBIDDEN', message: cause.message, cause });
  }
  if (cause instanceof BadRequestError) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: cause.message, cause });
  }
};

/** Run a pre-next() check, surfacing its domain error as the mapped tRPC error. */
const check = async (run: () => Promise<unknown>): Promise<void> => {
  try {
    await run();
  } catch (error) {
    rethrowProjectDomainError(error);
    throw error;
  }
};

/** Authorizes the caller against `workspaceId` (a non-member gets NOT_FOUND) and maps
 * the project domain's errors from the resolver. For workspace-level procedures
 * (creating/listing projects, product enablement). */
export const protectedWorkspaceProcedure = protectedProcedure.use(async ({ ctx, getRawInput, next }) => {
  const { workspaceId } = workspaceScopedInput.parse(await getRawInput());
  await check(async () => {
    await ctx.workspace.assertMember(ctx.headers, workspaceId);
  });
  const result = await next();
  if (!result.ok) {
    rethrowProjectDomainError(result.error.cause);
  }
  return result;
});

/** Additionally proves `projectId` belongs to `workspaceId` — a foreign or unknown
 * project is NOT_FOUND before any resolver runs. */
export const protectedProjectProcedure = protectedWorkspaceProcedure.use(async ({ ctx, getRawInput, next }) => {
  const { workspaceId, projectId } = projectScopedInput.parse(await getRawInput());
  await check(async () => await ctx.projects.requireProject(workspaceId, projectId));
  return await next();
});

/** A project procedure that also requires `product` to be enabled in the workspace
 * (FORBIDDEN otherwise). Product routers build on this: `productProcedure(Products.ota)`. */
export const productProcedure = (product: Product) =>
  protectedProjectProcedure.use(async ({ ctx, getRawInput, next }) => {
    const { workspaceId } = workspaceScopedInput.parse(await getRawInput());
    await check(async () => {
      await ctx.products.assertEnabled(workspaceId, product);
    });
    return await next();
  });
