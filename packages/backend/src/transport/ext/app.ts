// External inbound REST surface (ADR 0011): a Hono app mounted under the Next
// App Router at /api/ext. The ONLY file importing hono. Handlers parse at the
// boundary and delegate to domain services; no vendor/SQL detail is ever
// returned to the caller.
import { Hono } from 'hono';

import { getServices } from '@backend/domain/auth/instance';
import { ConnectionClaimedError, ConnectStateInvalidError } from '@backend/domain/integration/errors';
import { GithubApiError } from '@backend/domain/integration/github/errors';
import { getIntegration } from '@backend/domain/integration/instance';

import type { AuthService } from '@backend/domain/auth/AuthService';
import type { ConnectionService } from '@backend/domain/integration/ConnectionService';
import type { GitHubProvider } from '@backend/domain/integration/github/provider';

export interface ExtDeps {
  auth: AuthService;
  connection: ConnectionService;
  provider: GitHubProvider;
}

const WORKSPACES = '/workspaces';
const SIGN_IN = '/auth/sign-in';

/** Testable Hono app — inject deps (prod builds them from the composition roots below). */
export function createExtApp(deps: ExtDeps): Hono {
  const app = new Hono().basePath('/api/ext');

  // GitHub App post-install setup callback (slice 3a). Browser redirect from GitHub.
  app.get('/github/setup', async c => {
    const session = await deps.auth.getSession(c.req.raw.headers);
    if (!session) {
      return c.redirect(SIGN_IN);
    }

    const setupAction = c.req.query('setup_action');
    const installationId = c.req.query('installation_id');
    const code = c.req.query('code');
    const state = c.req.query('state') ?? '';

    // Org requires admin approval — no installation yet; reconciled via webhook in 3b.
    if (setupAction === 'request' || installationId === undefined) {
      return c.redirect(`${WORKSPACES}?pending=1`);
    }
    if (code === undefined) {
      return c.redirect(`${WORKSPACES}?connect_error=1`);
    }

    try {
      // Consume the state (bound to this user) first, then prove installation ownership.
      const { workspaceId } = await deps.connection.consumeConnectState(state, session.user.id);
      const ownership = await deps.provider.verifyOwnership(code, installationId);
      if (!ownership.ownerVerified) {
        return c.redirect(`${WORKSPACES}?connect_error=1`);
      }
      await deps.connection.createConnection(workspaceId, {
        externalAccountId: installationId,
        accountLogin: ownership.accountLogin,
      });
      return c.redirect(`${WORKSPACES}/${workspaceId}`);
    } catch (error) {
      // Expected failures redirect gracefully; unexpected errors surface as a generic 500.
      if (
        error instanceof ConnectStateInvalidError ||
        error instanceof GithubApiError ||
        error instanceof ConnectionClaimedError
      ) {
        return c.redirect(`${WORKSPACES}?connect_error=1`);
      }
      throw error;
    }
  });

  return app;
}

/** Production fetch handler — mounted by the App Router at app/api/ext/[[...route]]/route.ts. */
export async function extHandler(request: Request): Promise<Response> {
  const integration = getIntegration();
  if (!integration) {
    return new Response('GitHub integration is not configured', { status: 503 });
  }
  const app = createExtApp({
    auth: getServices().auth,
    connection: integration.connection,
    provider: integration.provider,
  });
  return await app.fetch(request);
}
