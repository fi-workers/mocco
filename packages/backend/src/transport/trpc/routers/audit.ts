// Audit domain router — thin: parse at the boundary (zod DTOs from @mocco/common),
// delegate to the injected AuditService, and map this domain's errors here
// (NotFoundError -> NOT_FOUND) via a router-scoped middleware. Like the run/role
// routers, `ctx.audit` is always present (the audit domain has no external
// dependency — the hash chain is self-contained), so there is no "not configured"
// branch. Read-only: the write-path appends from the governance/credential/execution
// services (slice 8, PR2), never through this surface.
import { auditEntrySchema, chainVerificationSchema } from '@mocco/common/audit';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { NotFoundError } from '@backend/domain/errors';
import { protectedProcedure, router } from '@backend/transport/trpc/trpc';

// Every audit procedure is workspace-scoped and takes `workspaceId` in its input;
// this is the seam that authorizes the caller against it (each workspace owns its
// own chain, so the read is per-tenant).
const workspaceScopedInput = z.object({ workspaceId: z.uuid() });

// Re-raise a NotFoundError-family cause as NOT_FOUND; a no-op for anything else.
// Only the pre-next() assertMember catch can throw here (WorkspaceNotFoundError for a
// non-member); the AuditService reads never throw a domain error.
const rethrowMappedDomainError = (cause: unknown): void => {
  if (cause instanceof NotFoundError) {
    throw new TRPCError({ code: 'NOT_FOUND', message: cause.message, cause });
  }
};

// Authorizes the caller against the workspaceId they passed, then maps this domain's
// error family — mirrors the run/role routers' protected*Procedure.
const protectedAuditProcedure = protectedProcedure.use(async ({ ctx, getRawInput, next }) => {
  // Authorize BEFORE any resolver touches the workspaceId: scoping DB queries by a
  // caller-supplied workspaceId is not isolation unless the caller is proven a member
  // of it. assertMember throws WorkspaceNotFoundError (a NotFoundError) for a
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

export const auditRouter = router({
  // The chain, oldest-first. `sinceSeq` is a digit-string cursor (audit_log.seq is a
  // DB bigserial that exceeds JS safe-integer range), converted to bigint at the
  // boundary; each entry's seq is serialized back to a string for the wire. Absent
  // cursor reads from the head of the chain (sinceSeq 0).
  list: protectedAuditProcedure
    .input(workspaceScopedInput.extend({ sinceSeq: z.string().regex(/^\d+$/).optional() }))
    .output(z.object({ entries: z.array(auditEntrySchema) }))
    .query(async ({ ctx, input }) => {
      const entries = await ctx.audit.list(input.workspaceId, BigInt(input.sinceSeq ?? '0'));
      return { entries: entries.map(entry => ({ ...entry, seq: entry.seq.toString() })) };
    }),

  // Re-walk the workspace's chain and report whether it is intact. `brokenAtSeq` (the
  // proof-of-tamper coordinate) is a bigint on the service side, stringified for the
  // wire like every other bigserial.
  verify: protectedAuditProcedure
    .input(workspaceScopedInput)
    .output(chainVerificationSchema)
    .query(async ({ ctx, input }) => {
      const result = await ctx.audit.verify(input.workspaceId);
      return result.intact ? { intact: true } : { intact: false, brokenAtSeq: result.brokenAtSeq.toString() };
    }),
});
