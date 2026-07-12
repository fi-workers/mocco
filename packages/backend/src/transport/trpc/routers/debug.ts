import { publicProcedure, router } from '../trpc';

// Verification-only router: `throwInternal` throws so the tRPC error path
// (errorFormatter mask + onError → Sentry capture) can be confirmed end-to-end.
// Safe to remove once Sentry is verified.
export const debugRouter = router({
  throwInternal: publicProcedure.query(() => {
    throw new Error('Sentry tRPC verification error');
  }),
});
