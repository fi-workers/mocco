// Mocco on Mocco (docs/reference/mocco-on-mocco.md): the console's "What's new" badge and feedback
// sheet come from a Mocco project, and its signed-in user takes part as that project's end user.
// `GET /api/self/end-user-token` answers the signed-in console user an end-user token for that
// project, signed with its identity secret (MOCCO_SELF_IDENTITY_SECRET) exactly as a customer's
// server signs one: HS256, `sub` = the user's Mocco id, ten minutes. Anonymous callers get 401, and
// without the secret the route answers 404, so the widgets fall back to a visitor's view.
import { SELF_END_USER_TOKEN_TTL_SECONDS } from '@mocco/common/mocco-self';

import { getServices } from '@backend/domain/auth/instance';
import { signHs256 } from '@backend/domain/enduser/jwt';
import { getEnv } from '@backend/infra/config/env';

import type { Session } from '@mocco/common/auth';
import type { SelfEndUserToken } from '@mocco/common/mocco-self-token';

export interface SelfEndUserTokenDeps {
  /** The request's console session, or null. */
  sessionOf: (headers: Headers) => Promise<Pick<Session, 'user'> | null>;
  /** The identity secret of Mocco's own project; undefined when not configured. */
  identitySecret: string | undefined;
  now: () => Date;
}

export type SelfEndUserTokenAnswer =
  | { status: 200; body: SelfEndUserToken }
  | { status: 401; body: { error: string } }
  | { status: 404; body: { error: string } };

/** The answer to the console's token request. The token is never logged. */
export async function selfEndUserToken(deps: SelfEndUserTokenDeps, headers: Headers): Promise<SelfEndUserTokenAnswer> {
  if (deps.identitySecret === undefined) {
    return { status: 404, body: { error: 'Not configured' } };
  }
  const session = await deps.sessionOf(headers);
  if (session === null) {
    return { status: 401, body: { error: 'Sign in first' } };
  }
  const now = deps.now();
  const token = await signHs256(session.user.id, deps.identitySecret, now, SELF_END_USER_TOKEN_TTL_SECONDS);
  const expiresAt = new Date(Math.floor(now.getTime() / 1000) * 1000 + SELF_END_USER_TOKEN_TTL_SECONDS * 1000);
  return { status: 200, body: { token, expiresAt: expiresAt.toISOString() } };
}

/** The production binding: the console's auth session and the env's identity secret. */
export async function selfEndUserTokenFor(headers: Headers): Promise<SelfEndUserTokenAnswer> {
  const secret = getEnv().MOCCO_SELF_IDENTITY_SECRET;
  return await selfEndUserToken(
    {
      sessionOf: async requestHeaders => await getServices().auth.getSession(requestHeaders),
      identitySecret: secret,
      now: () => new Date(),
    },
    headers,
  );
}
