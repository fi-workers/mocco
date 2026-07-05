import { initTRPC, TRPCError } from '@trpc/server';
import superjson from 'superjson';

import type { Session } from '../auth/session';
import type { Db } from '../db/client';

/** Per-request tRPC context — session read via the neutral auth surface. */
export interface Context {
  db: Db;
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
