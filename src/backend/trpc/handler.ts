import { fetchRequestHandler } from '@trpc/server/adapters/fetch';

import { getAuth } from '../auth/instance';
import { getDb } from '../db/client';

import { appRouter } from './router';

import type { Context } from './trpc';
import type { AuthService } from '../auth/service';
import type { Db } from '../db/client';

/** DI factory — production binds it below; tests bind it to pglite. */
export function createTrpcHandler(deps: { db: Db; auth: AuthService }) {
  return (request: Request): Promise<Response> =>
    fetchRequestHandler({
      endpoint: '/api/trpc',
      req: request,
      router: appRouter,
      createContext: async (): Promise<Context> => ({
        db: deps.db,
        auth: deps.auth,
        session: await deps.auth.getSession(request.headers),
        headers: request.headers,
      }),
    });
}

/** Mounted by Next at app/api/trpc/[trpc]/route.ts. */
export function trpcHandler(request: Request): Promise<Response> {
  return createTrpcHandler({ db: getDb(), auth: getAuth() })(request);
}
