// Session/auth service — cohesive business-logic unit, one file per service.
// Takes the provider (the vendor handle, our "repo layer") as a value: deps
// flow in, so tests bind pglite through the same factory production uses.
import type { Provider } from './provider';
import type { Session } from '@mocco/common/auth';

export function createAuthService(provider: Provider) {
  return {
    /** Fetch-standard handler (Request → Response) for the auth routes. */
    handler: (request: Request): Promise<Response> => provider.handler(request),

    /** Read the current session from request headers (cookie-based). */
    getSession: (headers: Headers): Promise<Session | null> => provider.api.getSession({ headers }),
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
