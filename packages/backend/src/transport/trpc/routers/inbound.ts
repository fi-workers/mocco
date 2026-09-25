// Inbound sources router — thin: parse at the boundary (zod from @mocco/common),
// delegate to the injected SourceService / InboundService, and map this domain's
// errors here (NotFound → NOT_FOUND, BadRequest → BAD_REQUEST, Forbidden → FORBIDDEN).
// Reads need membership; writes need an owner or admin. No output carries a sealed
// secret: `.output()` strips everything but the DTO, and a GitHub source's generated
// secret appears only in the create / rotateSecret result, once.
import {
  inboundReceiptsPageSchema,
  inboundReceiptsQuerySchema,
  inboundSecretSchema,
  inboundSourceCreateInputSchema,
  inboundSourceNameSchema,
  inboundSourceSchema,
} from '@mocco/common/inbound';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { BadRequestError, ForbiddenError, NotFoundError } from '@backend/domain/errors';
import { protectedProcedure, router } from '@backend/transport/trpc/trpc';

const workspaceScopedInput = z.object({ workspaceId: z.uuid() });
const sourceScopedInput = workspaceScopedInput.extend({ sourceId: z.uuid() });

const sourceOutput = z.object({ source: inboundSourceSchema });
const sourceWithSecretOutput = z.object({ source: inboundSourceSchema, generatedSecret: z.string().nullable() });

/** Re-raise this domain's error families as their tRPC codes; a no-op for anything else. */
const rethrowMappedDomainError = (cause: unknown): void => {
  if (cause instanceof NotFoundError) {
    throw new TRPCError({ code: 'NOT_FOUND', message: cause.message, cause });
  }
  if (cause instanceof ForbiddenError) {
    throw new TRPCError({ code: 'FORBIDDEN', message: cause.message, cause });
  }
  if (cause instanceof BadRequestError) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: cause.message, cause });
  }
};

const check = async (run: () => Promise<void>): Promise<void> => {
  try {
    await run();
  } catch (error) {
    rethrowMappedDomainError(error);
    throw error;
  }
};

// Requires the inbound domain (SECRETS_ENCRYPTION_KEYS set), authorizes the caller as a
// member of the workspaceId they passed (NOT_FOUND otherwise, before any resolver
// touches it), and maps the domain's errors from the resolver.
const protectedInboundProcedure = protectedProcedure.use(async ({ ctx, getRawInput, next }) => {
  if (!ctx.inbound) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Inbound webhooks are not configured' });
  }
  const { workspaceId } = workspaceScopedInput.parse(await getRawInput());
  await check(async () => {
    await ctx.workspace.assertMember(ctx.headers, workspaceId);
  });
  const result = await next({ ctx: { ...ctx, inbound: ctx.inbound } });
  if (!result.ok) {
    rethrowMappedDomainError(result.error.cause);
  }
  return result;
});

/** Writes: additionally an owner or admin of the workspace (FORBIDDEN for a member). */
const adminInboundProcedure = protectedInboundProcedure.use(async ({ ctx, getRawInput, next }) => {
  const { workspaceId } = workspaceScopedInput.parse(await getRawInput());
  await check(async () => {
    await ctx.workspace.assertAdmin(ctx.headers, workspaceId, ctx.session.user.id);
  });
  return await next();
});

const sourcesRouter = router({
  list: protectedInboundProcedure
    .input(workspaceScopedInput)
    .output(z.object({ sources: z.array(inboundSourceSchema) }))
    .query(async ({ ctx, input }) => ({ sources: await ctx.inbound.sources.list(input.workspaceId) })),

  create: adminInboundProcedure
    .input(workspaceScopedInput.extend(inboundSourceCreateInputSchema.shape))
    .output(sourceWithSecretOutput)
    .mutation(async ({ ctx, input }) => {
      const { workspaceId, ...source } = input;
      return await ctx.inbound.sources.create(workspaceId, source);
    }),

  rename: adminInboundProcedure
    .input(sourceScopedInput.extend({ name: inboundSourceNameSchema }))
    .output(sourceOutput)
    .mutation(async ({ ctx, input }) => ({
      source: await ctx.inbound.sources.rename(input.workspaceId, input.sourceId, input.name),
    })),

  pause: adminInboundProcedure
    .input(sourceScopedInput)
    .output(sourceOutput)
    .mutation(async ({ ctx, input }) => ({
      source: await ctx.inbound.sources.pause(input.workspaceId, input.sourceId),
    })),

  resume: adminInboundProcedure
    .input(sourceScopedInput)
    .output(sourceOutput)
    .mutation(async ({ ctx, input }) => ({
      source: await ctx.inbound.sources.resume(input.workspaceId, input.sourceId),
    })),

  rotateSecret: adminInboundProcedure
    .input(sourceScopedInput.extend({ secret: inboundSecretSchema.optional() }))
    .output(sourceWithSecretOutput)
    .mutation(
      async ({ ctx, input }) => await ctx.inbound.sources.rotateSecret(input.workspaceId, input.sourceId, input.secret),
    ),

  delete: adminInboundProcedure.input(sourceScopedInput).mutation(async ({ ctx, input }) => {
    await ctx.inbound.sources.delete(input.workspaceId, input.sourceId);
    return { ok: true } as const;
  }),
});

const receiptsRouter = router({
  // The activity trace, newest first. `beforeSeq` is a digit-string cursor (seq is a
  // bigserial), the previous page's `nextCursor`.
  list: protectedInboundProcedure
    .input(workspaceScopedInput.extend(inboundReceiptsQuerySchema.shape))
    .output(inboundReceiptsPageSchema)
    .query(async ({ ctx, input }) => {
      const { workspaceId, ...filter } = input;
      return await ctx.inbound.inbound.listReceipts(workspaceId, filter);
    }),
});

export const inboundRouter = router({
  sources: sourcesRouter,
  receipts: receiptsRouter,
});
