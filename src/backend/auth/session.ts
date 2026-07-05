// Neutral auth surface — no vendor names. The frontend mounts authHandler under
// app/api/auth/[...all]; server code reads the session via getSession().
import { getProvider, type Provider } from './provider';

/** Session shape exposed to the rest of the codebase (vendor-inferred, neutrally named). */
export type Session = Provider['$Infer']['Session'];
export type AuthUser = Session['user'];

/** Fetch-standard handler (Request → Response) for the auth routes. */
export function authHandler(request: Request): Promise<Response> {
  return getProvider().handler(request);
}

/** Read the current session from request headers (cookie-based). */
export function getSession(headers: Headers): Promise<Session | null> {
  return getProvider().api.getSession({ headers });
}
