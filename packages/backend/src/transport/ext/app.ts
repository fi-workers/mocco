// External inbound REST surface (ADR 0011): a Hono app mounted under the Next
// App Router at /api/ext. The ONLY file importing hono. Handlers parse at the
// boundary and delegate to domain services; no vendor/SQL detail is ever
// returned to the caller.
import { Providers } from '@mocco/common/integration';
import { waitUntil } from '@vercel/functions';
import { Hono } from 'hono';

import { getServices } from '@backend/domain/auth/instance';
import { ConnectionClaimedError, ConnectStateInvalidError } from '@backend/domain/integration/errors';
import { GithubApiError } from '@backend/domain/integration/github/errors';
import { parseWebhook, verify } from '@backend/domain/integration/github/provider';
import { getIntegration } from '@backend/domain/integration/instance';
import { getEnv } from '@backend/infra/config/env';

import type { AuthService } from '@backend/domain/auth/AuthService';
import type { CommitSyncService } from '@backend/domain/integration/CommitSyncService';
import type { ConnectionService } from '@backend/domain/integration/ConnectionService';
import type { GitHubProvider } from '@backend/domain/integration/github/provider';
import type { WebhookDeliveryRepo } from '@backend/domain/integration/repos/webhook-delivery.repo';

export interface ExtDeps {
  auth: AuthService;
  connection: ConnectionService;
  provider: GitHubProvider;
  commitSync: CommitSyncService;
  deliveries: WebhookDeliveryRepo;
  /** GitHub webhook HMAC secret; `undefined` when unconfigured (the route 503s). */
  webhookSecret: string | undefined;
  /** Injection seam: prod passes `@vercel/functions`'s waitUntil; tests pass a
   * synchronous collector so the deferred sync is observable without vi.mock. */
  waitUntil: (promise: Promise<unknown>) => void;
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

  // GitHub App webhook receiver (slice 3b). Verify-first, ack fast, sync deferred.
  //
  // installation.created reconciliation: the route already routes it to
  // commitSync.handle, whose reconcile matches on the sender's github_user_id
  // against a pending connect-state. Live reconciliation requires stamping
  // github_user_id on the connect-state at the setup redirect (pending: needs
  // verification of GitHub OAuth-during-install behavior on the request path);
  // until then the request-flow parks unclaimed. Logic is unit-tested (Task 7).
  app.post('/github/webhook', async c => {
    if (deps.webhookSecret === undefined) {
      // No secret configured — signatures can't be verified, so nothing is trusted.
      return c.text('GitHub webhook is not configured', 503);
    }
    // Read the RAW body BEFORE any parse — the HMAC is computed over the exact bytes.
    const raw = await c.req.text();
    if (!verify(raw, c.req.header('x-hub-signature-256') ?? null, deps.webhookSecret)) {
      // Invalid/absent signature — reject with NO writes and no detail.
      return c.text('invalid signature', 401);
    }

    const deliveryId = c.req.header('x-github-delivery');
    if (deliveryId === undefined) {
      return c.text('missing delivery id', 400);
    }
    const eventType = c.req.header('x-github-event') ?? null;

    // Idempotent by delivery id: a redelivery must never reprocess.
    const isNew = await deps.deliveries.recordIfNew(Providers.github, deliveryId, eventType ?? 'unknown');
    if (!isNew) {
      return c.text('duplicate delivery', 202);
    }

    // New delivery: ack immediately and defer the sync so GitHub's ~10s budget is
    // never spent on our work. waitUntil keeps the promise alive past the response.
    // n/no-sync false-positives on the `commitSync` identifier (its `/Sync$/` heuristic).
    // eslint-disable-next-line n/no-sync
    deps.waitUntil(deps.commitSync.handle(parseWebhook(eventType, raw)));
    return c.text('accepted', 202);
  });

  // Defense-in-depth (symmetric with the tRPC maskInternalError): an unexpected
  // throw surfaces as a fixed generic 500 — never a vendor/SQL/token detail.
  app.onError((_error, c) => c.text('Internal server error', 500));

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
    commitSync: integration.commitSync,
    deliveries: integration.deliveries,
    // Undefined here → the webhook route 503s, mirroring the integration-unconfigured 503.
    webhookSecret: getEnv().GITHUB_WEBHOOK_SECRET,
    waitUntil,
  });
  return await app.fetch(request);
}
