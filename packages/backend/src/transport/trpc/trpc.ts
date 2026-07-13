import { initTRPC, TRPCError } from '@trpc/server';
import superjson from 'superjson';

import { NotFoundError } from '../../domain/errors';

import type { AuthService } from '../../domain/auth/AuthService';
import type { WorkspaceService } from '../../domain/auth/WorkspaceService';
import type { Session } from '@mocco/common/auth';

/** Per-request tRPC context — session read via the neutral auth surface. */
export interface Context {
  /** Injected services (production instances or per-test pglite ones). */
  auth: AuthService;
  workspace: WorkspaceService;
  session: Session | null;
  /** Original request headers — forwarded to neutral auth calls (cookie-based). */
  headers: Headers;
  /** Debug/verification procedures are gated on this (set by the HTTP handler). */
  debugEnabled?: boolean;
}

/** Mask internal errors before they reach the client: an uncaught throw surfaces
 * as INTERNAL_SERVER_ERROR whose message is the raw cause (SQL, vendor detail) —
 * replace it with a generic message. Explicit domain errors (BAD_REQUEST,
 * UNAUTHORIZED, …) keep their message. Pure, so it is unit-tested directly. */
export function maskInternalError<S extends { message: string }>(shape: S, code: string): S {
  if (code === 'INTERNAL_SERVER_ERROR') {
    return { ...shape, message: 'Internal server error' };
  }
  return shape;
}

const t = initTRPC.context<Context>().create({
  transformer: superjson,
  errorFormatter: ({ shape, error }) => maskInternalError(shape, error.code),
});

export const { router } = t;

/**
 * Maps domain error families to transport codes in one place — services throw
 * them (colocated in each domain's errors.ts), so procedures stay plumbing-free.
 * A `NotFoundError` (wrapped by tRPC as the cause) becomes NOT_FOUND.
 */
const mapDomainErrors = t.middleware(async ({ next }) => {
  const result = await next();
  if (!result.ok && result.error.cause instanceof NotFoundError) {
    throw new TRPCError({ code: 'NOT_FOUND', message: result.error.cause.message, cause: result.error.cause });
  }
  return result;
});

export const publicProcedure = t.procedure.use(mapDomainErrors);

/** Requires a signed-in user; narrows ctx.session to non-null. */
export const protectedProcedure = publicProcedure.use(async ({ ctx, next }) => {
  if (!ctx.session) {
    throw new TRPCError({ code: 'UNAUTHORIZED' });
  }
  return await next({ ctx: { ...ctx, session: ctx.session } });
});
