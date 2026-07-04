import { fetchRequestHandler } from '@trpc/server/adapters/fetch';

import { getSession } from '../auth';
import { db } from '../db/client';

import { appRouter } from './router';

import type { Context } from './trpc';

/** Mounted by Next at app/api/trpc/[trpc]/route.ts. */
export function trpcHandler(request: Request): Promise<Response> {
  return fetchRequestHandler({
    endpoint: '/api/trpc',
    req: request,
    router: appRouter,
    createContext: async (): Promise<Context> => ({
      db,
      session: await getSession(request.headers),
      headers: request.headers,
    }),
  });
}
