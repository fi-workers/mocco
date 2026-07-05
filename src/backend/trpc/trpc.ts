import { initTRPC, TRPCError } from '@trpc/server';
import superjson from 'superjson';

import type { AuthService } from '../auth/AuthService';
import type { WorkspaceService } from '../auth/WorkspaceService';
import type { Db } from '../db/client';
import type { Session } from '@mocco/common/auth';

/** Per-request tRPC context — session read via the neutral auth surface. */
export interface Context {
  db: Db;
  /** Injected services (production instances or per-test pglite ones). */
  auth: AuthService;
  workspace: WorkspaceService;
  session: Session | null;
  /** Original request headers — forwarded to neutral auth calls (cookie-based). */
  headers: Headers;
}

const t = initTRPC.context<Context>().create({ transformer: superjson });

export const { router } = t;
export const publicProcedure = t.procedure;

/** Requires a signed-in user; narrows ctx.session to non-null. */
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.session) {
    throw new TRPCError({ code: 'UNAUTHORIZED' });
  }
  return next({ ctx: { ...ctx, session: ctx.session } });
});
