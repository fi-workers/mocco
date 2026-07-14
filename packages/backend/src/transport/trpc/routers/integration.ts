// Integration domain router — thin: parse at the boundary (zod from
// @mocco/common), delegate to the injected ConnectionService. Maps its own
// domain's errors here (NotFoundError -> NOT_FOUND) via a router-scoped
// middleware, which also asserts the GitHub App is configured.
import {
  availableRepoSchema,
  connectionSchema,
  repoAddInputSchema,
  repoSchema,
  watchedBranchInputSchema,
} from '@mocco/common/integration';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { NotFoundError } from '../../../domain/errors';
import { protectedProcedure, router } from '../trpc';

// Requires the GitHub App to be configured (ctx.connection present) and maps this
// domain's NotFoundError family to NOT_FOUND, reused across the router's procedures.
const protectedIntegrationProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  if (!ctx.connection) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'GitHub integration is not configured' });
  }
  const result = await next({ ctx: { ...ctx, connection: ctx.connection } });
  if (!result.ok && result.error.cause instanceof NotFoundError) {
    throw new TRPCError({ code: 'NOT_FOUND', message: result.error.cause.message, cause: result.error.cause });
  }
  return result;
});

export const integrationRouter = router({
  startInstall: protectedIntegrationProcedure
    .input(z.object({ workspaceId: z.uuid() }))
    .output(z.object({ installUrl: z.string() }))
    .mutation(async ({ ctx, input }) => await ctx.connection.startInstall(ctx.session.user.id, input.workspaceId)),

  connections: protectedIntegrationProcedure
    .input(z.object({ workspaceId: z.uuid() }))
    .output(z.object({ connections: z.array(connectionSchema) }))
    .query(async ({ ctx, input }) => ({ connections: await ctx.connection.listConnections(input.workspaceId) })),

  availableRepos: protectedIntegrationProcedure
    .input(z.object({ workspaceId: z.uuid(), connectionId: z.uuid() }))
    .output(z.object({ repos: z.array(availableRepoSchema) }))
    .query(async ({ ctx, input }) => ({
      repos: await ctx.connection.availableRepos(input.workspaceId, input.connectionId),
    })),

  repos: protectedIntegrationProcedure
    .input(z.object({ workspaceId: z.uuid() }))
    .output(z.object({ repos: z.array(repoSchema) }))
    .query(async ({ ctx, input }) => ({ repos: await ctx.connection.listRepos(input.workspaceId) })),

  addRepo: protectedIntegrationProcedure
    .input(repoAddInputSchema.extend({ workspaceId: z.uuid() }))
    .output(z.object({ repo: repoSchema }))
    .mutation(async ({ ctx, input }) => ({ repo: await ctx.connection.addRepo(input.workspaceId, input) })),

  setWatchedBranch: protectedIntegrationProcedure
    .input(watchedBranchInputSchema.extend({ workspaceId: z.uuid() }))
    .output(z.object({ repo: repoSchema }))
    .mutation(async ({ ctx, input }) => ({
      repo: await ctx.connection.setWatchedBranch(input.workspaceId, input.repoId, input.watchedBranch),
    })),
});
