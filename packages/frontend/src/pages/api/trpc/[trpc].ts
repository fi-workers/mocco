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
    const { auth, workspace, pipeline } = getServices();
    const headers = headersFromNode(req.headers);
    return { auth, workspace, pipeline, session: await auth.getSession(headers), headers };
  },
});
