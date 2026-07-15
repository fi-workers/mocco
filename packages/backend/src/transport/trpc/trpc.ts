import { initTRPC, TRPCError } from '@trpc/server';
import superjson from 'superjson';

import type { AuthService } from '@backend/domain/auth/AuthService';
import type { WorkspaceService } from '@backend/domain/auth/WorkspaceService';
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
export const publicProcedure = t.procedure;

/** Requires a signed-in user; narrows ctx.session to non-null. */
export const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.session) {
    throw new TRPCError({ code: 'UNAUTHORIZED' });
  }
  return await next({ ctx: { ...ctx, session: ctx.session } });
});
