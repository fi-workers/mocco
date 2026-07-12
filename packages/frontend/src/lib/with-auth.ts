import { getServices } from '@mocco/backend/auth/instance';

import { headersFromNode } from './node-headers';
import { Routes } from './routes';

import type { Services } from '@mocco/backend/auth/instance';
import type { Session } from '@mocco/common/auth';
import type { GetServerSideProps, GetServerSidePropsContext, GetServerSidePropsResult } from 'next';

/** What a guarded getServerSideProps receives once auth has passed. */
export interface AuthContext extends Services {
  session: Session;
  headers: Headers;
}

/**
 * Auth guard for Pages Router pages: wraps a getServerSideProps so the session
 * check + redirect live in one place. Unauthenticated requests never reach the
 * handler — they are sent to /auth/sign-in. The handler receives the resolved
 * session and services (ready to build a tRPC caller).
 */
export function withAuth<P extends Record<string, unknown>>(
  handler: (context: GetServerSidePropsContext, auth: AuthContext) => Promise<GetServerSidePropsResult<P>>,
): GetServerSideProps<P> {
  return async context => {
    const { auth, workspace } = getServices();
    const headers = headersFromNode(context.req.headers);
    const session = await auth.getSession(headers);
    if (!session) {
      return { redirect: { destination: Routes.signIn, permanent: false } };
    }
    return await handler(context, { auth, workspace, session, headers });
  };
}
