// Execution/run domain router — thin: parse at the boundary (zod DTOs from
// @mocco/common), delegate to the injected RunService, and map this domain's
// errors here (NotFoundError -> NOT_FOUND, BadRequestError -> BAD_REQUEST) via a
// router-scoped middleware. Unlike the integration router, `ctx.runs` is always
// present (the execution domain has no external dependency to gate on), so there
// is no PRECONDITION_FAILED "not configured" branch.
import { runEventSchema, runSchema, runStepSchema } from '@mocco/common/execution';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { BadRequestError, NotFoundError } from '@backend/domain/errors';
import { protectedProcedure, router } from '@backend/transport/trpc/trpc';

// Every run procedure is workspace-scoped and takes `workspaceId` in its input;
// this is the seam that authorizes the caller against it.
const workspaceScopedInput = z.object({ workspaceId: z.uuid() });

// Re-raise a NotFoundError/BadRequestError-family cause as NOT_FOUND/BAD_REQUEST;
// a no-op for anything else. Shared by the pre-next() assertMember catch (which
// only ever throws a NotFoundError) and the post-next() result branch (which also
// sees ConfigNotRunnableError, a BadRequestError, from RunService.trigger).
const rethrowMappedDomainError = (cause: unknown): void => {
  if (cause instanceof NotFoundError) {
    throw new TRPCError({ code: 'NOT_FOUND', message: cause.message, cause });
  }
  if (cause instanceof BadRequestError) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: cause.message, cause });
  }
};

// Authorizes the caller against the workspaceId they passed, then maps this
// domain's error families — mirrors integration.ts's protectedIntegrationProcedure
// (minus the GitHub-App gate, which runs need not carry).
const protectedRunProcedure = protectedProcedure.use(async ({ ctx, getRawInput, next }) => {
  // Authorize BEFORE any resolver touches the workspaceId: scoping DB queries by a
  // caller-supplied workspaceId is not isolation unless the caller is proven a
  // member of it. assertMember throws WorkspaceNotFoundError (a NotFoundError) for
  // a non-member, which we surface as NOT_FOUND.
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

export const runRouter = router({
  // Create a run for a commit candidate (no dispatch yet — PR3 runs the loop).
  // `callbackTokenHash` never crosses the wire: `.output(runSchema)` strips it.
  trigger: protectedRunProcedure
    .input(z.object({ workspaceId: z.uuid(), commitId: z.uuid() }))
    .output(z.object({ run: runSchema }))
    .mutation(async ({ ctx, input }) => ({
      run: await ctx.runs.trigger(input.workspaceId, input.commitId, ctx.session.user.id),
    })),

  get: protectedRunProcedure
    .input(z.object({ workspaceId: z.uuid(), runId: z.uuid() }))
    .output(z.object({ run: runSchema, steps: z.array(runStepSchema) }))
    .query(async ({ ctx, input }) => await ctx.runs.get(input.workspaceId, input.runId)),

  // The live-poll read. `sinceSeq` is a digit-string cursor (run_events.seq is a
  // DB bigserial that exceeds JS safe-integer range), converted to bigint at the
  // boundary; each event's seq is serialized back to a string for the wire.
  events: protectedRunProcedure
    .input(z.object({ workspaceId: z.uuid(), runId: z.uuid(), sinceSeq: z.string().regex(/^\d+$/) }))
    .output(z.object({ run: runSchema, events: z.array(runEventSchema) }))
    .query(async ({ ctx, input }) => {
      const { run, events } = await ctx.runs.observe(input.workspaceId, input.runId, BigInt(input.sinceSeq));
      return { run, events: events.map(event => ({ ...event, seq: event.seq.toString() })) };
    }),
});
