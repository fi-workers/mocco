import { fetchRequestHandler } from '@trpc/server/adapters/fetch';

import { getServices, type Services } from '../../domain/auth/instance';
import { getIntegration } from '../../domain/integration/instance';

import { appRouter } from './root';

import type { Context } from './trpc';
import type { ConnectionService } from '../../domain/integration/ConnectionService';

/** Injected per-handler deps. `connection` is present only when the GitHub App is configured. */
export interface TrpcDeps extends Services {
  connection?: ConnectionService;
}

/** DI factory — production binds it below; tests bind it to pglite. */
export function createTrpcHandler(deps: TrpcDeps) {
  return async (request: Request): Promise<Response> =>
    await fetchRequestHandler({
      endpoint: '/api/trpc',
      req: request,
      router: appRouter,
      // Invariant: procedures read the session from `request.headers` but this
      // handler does NOT forward any `Set-Cookie` an auth call might emit back
      // onto the response. It holds only because the tRPC-path auth calls today
      // (list/create/setActive/getActive) mutate the DB session row, not cookies.
      // If that changes — session cookieCache, sign-in/out moved onto tRPC, or
      // vendor session rotation — capture the auth Response headers and merge
      // Set-Cookie here (via responseMeta), or those cookie updates are lost.
      createContext: async (): Promise<Context> => ({
        auth: deps.auth,
        workspace: deps.workspace,
        connection: deps.connection,
        session: await deps.auth.getSession(request.headers),
        headers: request.headers,
      }),
    });
}

/** Production tRPC fetch handler (prod is mounted via the Pages-Router `pages/api/trpc/[trpc].ts`). */
export async function trpcHandler(request: Request): Promise<Response> {
  return await createTrpcHandler({ ...getServices(), connection: getIntegration()?.connection })(request);
}
