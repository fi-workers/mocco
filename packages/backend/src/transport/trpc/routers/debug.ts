import { TRPCError } from '@trpc/server';

import { publicProcedure, router } from '@backend/transport/trpc/trpc';

// Verification-only router: `throwInternal` throws so the tRPC error path
// (errorFormatter mask + onError → Sentry capture) can be confirmed end-to-end.
// Gated on ctx.debugEnabled (NEXT_PUBLIC_DEBUG=true) — NOT_FOUND when debug is off.
export const debugRouter = router({
  throwInternal: publicProcedure.query(({ ctx }) => {
    if (!ctx.debugEnabled) {
      throw new TRPCError({ code: 'NOT_FOUND' });
    }
    throw new Error('Sentry tRPC verification error');
  }),
});
