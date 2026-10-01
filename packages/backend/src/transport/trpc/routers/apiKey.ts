// API key router (ADR 0017) — thin: list a project's keys (members), create and revoke
// them (owners and admins: a key grants API access to the project). The token is
// returned once, by `create`; no procedure ever returns it again.
import { apiKeyCreateInputSchema, apiKeySchema } from '@mocco/common/apikey';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { ForbiddenError, NotFoundError } from '@backend/domain/errors';
import { protectedProjectProcedure } from '@backend/transport/trpc/project-procedures';
import { router } from '@backend/transport/trpc/trpc';

const projectInput = z.object({ workspaceId: z.uuid(), projectId: z.uuid() });

const rethrowKeyError = (cause: unknown): void => {
  if (cause instanceof NotFoundError) {
    throw new TRPCError({ code: 'NOT_FOUND', message: cause.message, cause });
  }
  if (cause instanceof ForbiddenError) {
    throw new TRPCError({ code: 'FORBIDDEN', message: cause.message, cause });
  }
};

/** Owners and admins of the workspace; a plain member gets FORBIDDEN. */
const adminProjectProcedure = protectedProjectProcedure.use(async ({ ctx, getRawInput, next }) => {
  const { workspaceId } = projectInput.parse(await getRawInput());
  try {
    await ctx.workspace.assertAdmin(ctx.headers, workspaceId);
  } catch (error) {
    rethrowKeyError(error);
    throw error;
  }
  const result = await next();
  if (!result.ok) {
    rethrowKeyError(result.error.cause);
  }
  return result;
});

export const apiKeyRouter = router({
  list: protectedProjectProcedure
    .input(projectInput)
    .output(z.object({ keys: z.array(apiKeySchema) }))
    .query(async ({ ctx, input }) => ({ keys: await ctx.apiKeys.list(input.workspaceId, input.projectId) })),

  create: adminProjectProcedure
    .input(projectInput.and(apiKeyCreateInputSchema))
    .output(z.object({ key: apiKeySchema, token: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const { workspaceId, projectId, ...key } = input;
      return await ctx.apiKeys.create(workspaceId, projectId, ctx.session.user.id, key);
    }),

  revoke: adminProjectProcedure.input(projectInput.extend({ keyId: z.uuid() })).mutation(async ({ ctx, input }) => {
    await ctx.apiKeys.revoke(input.workspaceId, input.projectId, ctx.session.user.id, input.keyId);
    return { ok: true } as const;
  }),
});
