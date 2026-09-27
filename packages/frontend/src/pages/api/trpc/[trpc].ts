// tRPC Pages Router API route. tRPC's own Node adapter builds the per-request
// context: the production services come from the backend's single composition
// (`productionServices`), plus the session read from the request headers.
import { productionServices } from '@mocco/backend/trpc/handler';
import { appRouter } from '@mocco/backend/trpc/root';
import { createNextApiHandler } from '@trpc/server/adapters/next';

import { Monitoring } from '@frontend/lib/monitoring';
import { headersFromNode } from '@frontend/lib/node-headers';

import type { Context } from '@mocco/backend/trpc/trpc';

export default createNextApiHandler({
  router: appRouter,
  createContext: async ({ req }): Promise<Context> => {
    const services = productionServices();
    const headers = headersFromNode(req.headers);
    return { ...services, session: await services.auth.getSession(headers), headers };
  },
  // The client only ever sees the masked message (errorFormatter); keep the real
  // internal error visible server-side. Structured Sentry capture hooks in here.
  onError: ({ error, path }) => {
    if (error.code !== 'INTERNAL_SERVER_ERROR') {
      return;
    }
    Monitoring.captureException(error.cause ?? error, { trpcPath: path ?? null });
    console.error(`tRPC ${path ?? '<no-path>'}:`, error);
  },
});
