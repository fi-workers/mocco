// tRPC Pages Router API route. tRPC's own Node adapter builds the per-request
// context from the neutral services (session read from the request headers).
import { getServices } from '@mocco/backend/auth/instance';
import { appRouter } from '@mocco/backend/trpc/root';
import { createNextApiHandler } from '@trpc/server/adapters/next';

import { headersFromNode } from '../../../lib/node-headers';

import type { Context } from '@mocco/backend/trpc/trpc';

export default createNextApiHandler({
  router: appRouter,
  createContext: async ({ req }): Promise<Context> => {
    const { auth, workspace } = getServices();
    const headers = headersFromNode(req.headers);
    return { auth, workspace, session: await auth.getSession(headers), headers };
  },
  // The client only ever sees the masked message (errorFormatter); keep the real
  // internal error visible server-side. Structured Sentry capture hooks in here.
  onError: ({ error, path }) => {
    if (error.code === 'INTERNAL_SERVER_ERROR') {
      console.error(`tRPC ${path ?? '<no-path>'}:`, error);
    }
  },
});
