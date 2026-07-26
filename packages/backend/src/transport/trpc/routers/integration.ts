// Integration domain router — thin: parse at the boundary (zod from
// @mocco/common), delegate to the injected ConnectionService. Maps its own
// domain's errors here (NotFoundError -> NOT_FOUND, ForbiddenError -> FORBIDDEN)
// via a router-scoped middleware, which also asserts the GitHub App is configured.
import {
  availableRepoSchema,
  commitDetailQueryInputSchema,
  commitDetailSchema,
  commitsPageSchema,
  commitsQueryInputSchema,
  connectionSchema,
  repoAddInputSchema,
  repoSchema,
  watchedBranchInputSchema,
} from '@mocco/common/integration';
import { TRPCError } from '@trpc/server';
import { waitUntil } from '@vercel/functions';
import { z } from 'zod';

import { ForbiddenError, NotFoundError } from '@backend/domain/errors';
import { protectedProcedure, router } from '@backend/transport/trpc/trpc';

// Every integration procedure is workspace-scoped and takes `workspaceId` in its
// input; this is the seam that authorizes it.
const workspaceScopedInput = z.object({ workspaceId: z.uuid() });

// Re-raise a NotFoundError/ForbiddenError-family cause as NOT_FOUND/FORBIDDEN; a
// no-op for anything else. Shared by the pre-next() assertMember catch (which only
// ever throws a NotFoundError) and the post-next() result branch (which also sees
// ForbiddenError, e.g. a revoked GitHub installation surfaced by the adapter).
const rethrowMappedDomainError = (cause: unknown): void => {
  if (cause instanceof NotFoundError) {
    throw new TRPCError({ code: 'NOT_FOUND', message: cause.message, cause });
  }
  if (cause instanceof ForbiddenError) {
    throw new TRPCError({ code: 'FORBIDDEN', message: cause.message, cause });
  }
};

// Requires the GitHub App to be configured (ctx.connection present), authorizes the
// caller against the workspaceId they passed, and maps this domain's NotFoundError/
// ForbiddenError families to NOT_FOUND/FORBIDDEN — reused across the router's procedures.
const protectedIntegrationProcedure = protectedProcedure.use(async ({ ctx, getRawInput, next }) => {
  if (!ctx.connection) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'GitHub integration is not configured' });
  }
  // Authorize BEFORE any resolver touches the workspaceId: scoping DB queries by a
  // caller-supplied workspaceId is not isolation unless the caller is proven a
  // member of it (spec INVARIANT a). assertMember throws WorkspaceNotFoundError
  // (a NotFoundError) for a non-member, which we surface as NOT_FOUND.
  const { workspaceId } = workspaceScopedInput.parse(await getRawInput());
  try {
    await ctx.workspace.assertMember(ctx.headers, workspaceId);
  } catch (error) {
    rethrowMappedDomainError(error);
    throw error;
  }
  const result = await next({ ctx: { ...ctx, connection: ctx.connection } });
  if (!result.ok) {
    rethrowMappedDomainError(result.error.cause);
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
    .mutation(async ({ ctx, input }) => {
      const repo = await ctx.connection.setWatchedBranch(input.workspaceId, input.repoId, input.watchedBranch);
      // Best-effort: a freshly-watched branch gets its recent history backfilled
      // in the background (waitUntil) so the mutation doesn't wait on a GitHub
      // round-trip. `commitSync` carries the same "GitHub App configured"
      // optionality as `connection` (both built together in instance.ts) — skip
      // rather than throw if it's ever absent.
      if (input.watchedBranch !== null && ctx.commitSync) {
        // `commitSync` is the CommitSyncService Context field (see trpc.ts), not a
        // Node sync fs API — n/no-sync's `/Sync$/` identifier heuristic false-positives here.
        // eslint-disable-next-line n/no-sync
        waitUntil(ctx.commitSync.backfillRepo(repo));
      }
      return { repo };
    }),

  // The candidate-queue read path. `commitSync` carries the same "GitHub App configured"
  // optionality as `connection` (both built together in instance.ts, see trpc.ts) — the
  // shared middleware above only narrows `connection`, so this procedure re-asserts its
  // own dependency rather than assuming co-presence.
  commits: protectedIntegrationProcedure
    .input(commitsQueryInputSchema)
    .output(commitsPageSchema)
    .query(async ({ ctx, input }) => {
      if (!ctx.commitSync) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'GitHub integration is not configured' });
      }
      // `commitSync` is the CommitSyncService Context field, not a Node sync fs API —
      // n/no-sync's `/Sync$/` identifier heuristic false-positives here (see also above).
      // eslint-disable-next-line n/no-sync
      return await ctx.commitSync.listCommits(input.workspaceId, input.repoId, input.cursor, input.limit);
    }),

  // A single commit plus its `.mocco.yml` snapshot (or `config: null` if it hasn't
  // been snapshotted yet). `commitConfig` carries the same "GitHub App configured"
  // optionality as `connection`/`commitSync` (all three built together in
  // instance.ts, see trpc.ts) — re-asserted here like `commits` does for
  // `commitSync`, since the shared middleware above only narrows `connection`.
  // No hand-projection: `getDetail`'s return narrows to the wire shape via
  // `.output(commitDetailSchema)` alone.
  commitDetail: protectedIntegrationProcedure
    .input(commitDetailQueryInputSchema)
    .output(commitDetailSchema)
    .query(async ({ ctx, input }) => {
      if (!ctx.commitConfig) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'GitHub integration is not configured' });
      }
      return await ctx.commitConfig.getDetail(input.workspaceId, input.commitId);
    }),
});
