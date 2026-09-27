import { createHash } from 'node:crypto';

// External inbound REST surface (ADR 0011): a Hono app mounted under the Next
// App Router at /api/ext. transport/ext/ is the only hono importer. Handlers parse at the
// boundary and delegate to domain services; no vendor/SQL detail is ever
// returned to the caller.
import { credentialRequestSchema } from '@mocco/common/credential';
import { dispatchContextSchema, runCallbackSchema } from '@mocco/common/execution';
import { Providers } from '@mocco/common/integration';
import { versionSchema } from '@mocco/common/ota';
import { waitUntil } from '@vercel/functions';
import { Hono } from 'hono';
import { z } from 'zod';

import { getServices } from '@backend/domain/auth/instance';
import { getCredential } from '@backend/domain/credential/instance';
import { simulateStep } from '@backend/domain/execution/executors/generic/executor';
import { postJson } from '@backend/domain/execution/http';
import { getExecution } from '@backend/domain/execution/instance';
import { getInbound } from '@backend/domain/inbound/instance';
import { ConnectionClaimedError, ConnectStateInvalidError } from '@backend/domain/integration/errors';
import { GithubHeaders, GithubSetupActions } from '@backend/domain/integration/github/constants';
import { GithubApiError } from '@backend/domain/integration/github/errors';
import { parseWebhook, verify } from '@backend/domain/integration/github/provider';
import { getIntegration } from '@backend/domain/integration/instance';
import { JobTiming } from '@backend/domain/jobs/policy';
import { getNotification } from '@backend/domain/notification/instance';
import { getOtaDomain } from '@backend/domain/ota/instance';
import { getEnv } from '@backend/infra/config/env';
import { DEFAULT_TICK_MAX_JOBS, getJobRunner } from '@backend/runtime/jobs';
import { createDiscordInstallRoutes, type DiscordInstallDeps } from '@backend/transport/ext/discord';
import { createInboundRoutes } from '@backend/transport/ext/inbound';
import { createJobTickRoutes, type JobTickDeps } from '@backend/transport/ext/jobs';

import type { AuthService } from '@backend/domain/auth/AuthService';
import type { CredentialBroker } from '@backend/domain/credential/CredentialBroker';
import type { HttpPost } from '@backend/domain/execution/ports';
import type { RunService } from '@backend/domain/execution/RunService';
import type { InboundService } from '@backend/domain/inbound/InboundService';
import type { CommitSyncService } from '@backend/domain/integration/CommitSyncService';
import type { ConnectionService } from '@backend/domain/integration/ConnectionService';
import type { GitHubProvider } from '@backend/domain/integration/github/provider';
import type { WebhookDeliveryRepo } from '@backend/domain/integration/repos/webhook-delivery.repo';
import type { VersionCheckService } from '@backend/domain/ota/VersionCheckService';

export interface ExtDeps {
  auth: AuthService;
  // GitHub-App-gated deps — present only when the integration is configured. The
  // GitHub routes self-gate with a 503 when absent, so the execution loop's routes
  // (/callback, /executor/generic) stay live on a deploy with zero external accounts.
  connection?: ConnectionService;
  provider?: GitHubProvider;
  commitSync?: CommitSyncService;
  deliveries?: WebhookDeliveryRepo;
  /** The execution service — the callback funnel every executor reports through. */
  runs: RunService;
  /** The credential broker — the fail-closed enforcement `/credentials` delegates to.
   * Always present (the credential domain has no external dependency to gate on). */
  broker: CredentialBroker;
  /** The public version check (OTA version policy). Always present (no external dependency). */
  versionChecks: VersionCheckService;
  /** This deployment's own callback URL. `/executor/generic` posts callbacks HERE, never
   * to the URL in the request body — that endpoint is public, so trusting a caller-supplied
   * `callbackUrl` would be an SSRF (our server POSTing to an attacker-chosen host). */
  callbackUrl: string;
  /** Outbound-HTTP seam for the generic executor fn (prod = `postJson`; tests inject
   * a recorder). Kept separate from `RunService`'s own executor so both surfaces are testable. */
  postJson: HttpPost;
  /** GitHub webhook HMAC secret; `undefined` when unconfigured (the route 503s). */
  webhookSecret: string | undefined;
  /** Injection seam: prod passes `@vercel/functions`'s waitUntil; tests pass a
   * synchronous collector so the deferred sync is observable without vi.mock. */
  waitUntil: (promise: Promise<unknown>) => void;
  /** The job tick (`/internal/jobs/tick`); undefined when neither CRON_SECRET nor
   * JOBS_TICK_SECRET is set, and the route 503s. */
  jobTick?: JobTickDeps;
  /** Inbound webhooks (`/inbound/:ingestKey`); undefined when SECRETS_ENCRYPTION_KEYS is
   * not set (sealed secrets can't be opened), and the route 503s. */
  inbound?: InboundService;
  /** The Discord bot install (`/discord/install`, `/discord/callback`); undefined when
   * DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET / DISCORD_BOT_TOKEN are not all set, and
   * both routes 503. */
  discord?: DiscordInstallDeps;
}

const WORKSPACES = '/workspaces';

/** Version checks are public and identical for every user of an app version, so a CDN
 * may cache them briefly; a policy change reaches devices within about a minute. */
const VERSION_CHECK_CACHE = 'public, max-age=60, s-maxage=60, stale-while-revalidate=300';
const uuidSchema = z.uuid();
const localeSchema = z.string().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/);

/** A strong ETag over the exact response body, so an unchanged answer is a 304. */
function etagOf(body: string): string {
  return `"${createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`;
}
const SIGN_IN = '/auth/sign-in';

/** Parse a request body as JSON, yielding `undefined` for a malformed body (so the
 * route zod-rejects it as a 400 rather than throwing into the generic 500 handler). */
async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

/** Testable Hono app — inject deps (prod builds them from the composition roots below). */
export function createExtApp(deps: ExtDeps): Hono {
  const app = new Hono().basePath('/api/ext');

  // GitHub App post-install setup callback (slice 3a). Browser redirect from GitHub.
  app.get('/github/setup', async c => {
    const { connection, provider } = deps;
    if (!connection || !provider) {
      return c.text('GitHub integration is not configured', 503);
    }
    const session = await deps.auth.getSession(c.req.raw.headers);
    if (!session) {
      return c.redirect(SIGN_IN);
    }

    const setupAction = c.req.query('setup_action');
    const installationId = c.req.query('installation_id');
    const code = c.req.query('code');
    const state = c.req.query('state') ?? '';

    // Org requires admin approval — no installation yet; reconciled via webhook in 3b.
    if (setupAction === GithubSetupActions.request || installationId === undefined) {
      return c.redirect(`${WORKSPACES}?pending=1`);
    }
    if (code === undefined) {
      return c.redirect(`${WORKSPACES}?connect_error=1`);
    }

    try {
      // Consume the state (bound to this user) first, then prove installation ownership.
      const { workspaceId } = await connection.consumeConnectState(state, session.user.id);
      const ownership = await provider.verifyOwnership(code, installationId);
      if (!ownership.ownerVerified) {
        return c.redirect(`${WORKSPACES}?connect_error=1`);
      }
      await connection.createConnection(workspaceId, {
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
    const { commitSync, deliveries, webhookSecret } = deps;
    if (!commitSync || !deliveries || webhookSecret === undefined) {
      // Not configured (no secret / no integration) — signatures can't be verified,
      // so nothing is trusted.
      return c.text('GitHub webhook is not configured', 503);
    }
    // Read the RAW body BEFORE any parse — the HMAC is computed over the exact bytes.
    const raw = await c.req.text();
    if (!verify(raw, c.req.header(GithubHeaders.signature) ?? null, webhookSecret)) {
      // Invalid/absent signature — reject with NO writes and no detail.
      return c.text('invalid signature', 401);
    }

    const deliveryId = c.req.header(GithubHeaders.delivery);
    if (deliveryId === undefined) {
      return c.text('missing delivery id', 400);
    }
    const eventType = c.req.header(GithubHeaders.event) ?? null;

    // Idempotent by delivery id: a redelivery must never reprocess.
    const isNew = await deliveries.recordIfNew(Providers.github, deliveryId, eventType ?? 'unknown');
    if (!isNew) {
      return c.text('duplicate delivery', 202);
    }

    // New delivery: ack immediately and defer BOTH parse and sync so GitHub's ~10s
    // budget is never spent on our work, and a schema-invalid-but-signature-valid
    // payload never throws on the request path. If it did, the 500 would tell
    // GitHub to retry the same delivery — but recordIfNew above already marked it
    // seen, so the retry would dedup to 202 and the event would be silently dropped
    // forever. Parking it here (logged, swallowed) is an intentional at-most-once
    // drop for deterministically-unparseable events — clean, not silent data loss.
    deps.waitUntil(
      (async () => {
        try {
          // n/no-sync false-positives on the `commitSync` identifier (its `/Sync$/` heuristic).
          // eslint-disable-next-line n/no-sync
          await commitSync.handle(parseWebhook(eventType, raw));
        } catch (error) {
          console.error('[webhook] deferred processing failed', error);
        }
      })(),
    );
    return c.text('accepted', 202);
  });

  // Executor callback funnel (slice 4). The single inbound point every executor
  // (generic now, GitHub next slice) reports step progress through. Auth is the
  // per-run opaque token in the body, verified inside applyCallback (sha-256,
  // constant-time). Ack fast: the advance may dispatch the next step (outbound), so
  // it runs deferred. A rejected/failed callback is logged and swallowed — the
  // caller only ever sees a fixed generic status, never token/run/SQL detail.
  app.post('/callback', async c => {
    const body = await readJson(c.req.raw);
    const parsed = runCallbackSchema.safeParse(body);
    if (!parsed.success) {
      return c.text('invalid callback', 400);
    }
    const { token, ...update } = parsed.data;
    deps.waitUntil(
      (async () => {
        try {
          await deps.runs.applyCallback(token, update);
        } catch (error) {
          console.error('[callback] apply failed', error);
        }
      })(),
    );
    return c.text('accepted', 202);
  });

  // Credential broker (slice 7). A step's workflow asks for cloud credentials at
  // runtime; the broker issues them ONLY on the all-checks-pass path (§3 fail-closed:
  // valid per-run token, step actually dispatched by mocco, the step's gate resumed,
  // and the request within the workspace allowlist). Unlike /callback this is NOT
  // deferred — the caller needs the credentials in the response. Fail-closed: an
  // unparseable body or ANY denial returns the SAME fixed generic 403, so which check
  // failed is never revealed (the reason is logged inside the broker).
  app.post('/credentials', async c => {
    const parsed = credentialRequestSchema.safeParse(await readJson(c.req.raw));
    if (!parsed.success) {
      return c.text('denied', 403);
    }
    const result = await deps.broker.issue(parsed.data);
    if (!result.ok) {
      return c.text('denied', 403);
    }
    return c.json({ credentials: result.credentials }, 200);
  });

  // The generic executor serverless fn (slice 4). Receives the neutral dispatch
  // context (which step of which run, where/how to report back), "runs" a trivial
  // bounded step, and POSTs its callbacks — authed by the per-run token it carries.
  // Deferred so the trigger ACKs fast; a simulate failure is logged and parked.
  app.post('/executor/generic', async c => {
    const body = await readJson(c.req.raw);
    const parsed = dispatchContextSchema.safeParse(body);
    if (!parsed.success) {
      return c.text('invalid dispatch', 400);
    }
    // SSRF guard: this endpoint is public, so the caller-supplied `callbackUrl` is NOT
    // trusted — callbacks always go to THIS deployment's own callback URL.
    const ctx = { ...parsed.data, callbackUrl: deps.callbackUrl };
    deps.waitUntil(
      (async () => {
        try {
          await simulateStep(ctx, deps.postJson);
        } catch (error) {
          console.error('[executor/generic] simulate failed', error);
        }
      })(),
    );
    return c.text('accepted', 202);
  });

  // Public version check (OTA version policy, phase 2 of the OTA release control design).
  // Apps call it on launch with their installed version; the answer is ok | soft | hard
  // with the localized prompt and store link. Unauthenticated by design — the policy is
  // shown to every user of the app — keyed by the app id, and cacheable. An unknown app
  // or one without a policy is `ok`, so misconfiguration never locks users out.
  app.get('/v1/apps/:appId/version-check', async c => {
    const appId = uuidSchema.safeParse(c.req.param('appId'));
    const version = versionSchema.safeParse(c.req.query('version'));
    const localeParam = c.req.query('locale');
    const locale = localeParam === undefined ? undefined : localeSchema.safeParse(localeParam);
    if (!appId.success || !version.success || locale?.success === false) {
      return c.json({ error: 'invalid request' }, 400, { 'Access-Control-Allow-Origin': '*' });
    }
    const result = await deps.versionChecks.check(appId.data, version.data, locale?.data);
    const body = JSON.stringify(result);
    const etag = etagOf(body);
    const headers = {
      'Cache-Control': VERSION_CHECK_CACHE,
      ETag: etag,
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json; charset=utf-8',
    };
    if (c.req.header('if-none-match') === etag) {
      return c.body(null, 304, headers);
    }
    return c.body(body, 200, headers);
  });
  // Inbound webhooks from Sentry, Vercel and GitHub (notification relay design §5).
  app.route('/', createInboundRoutes(deps.inbound));
  // Discord bot install (relay design §6): /discord/install and /discord/callback.
  app.route('/', createDiscordInstallRoutes({ auth: deps.auth, discord: deps.discord }));

  // Job tick (ADR 0014): Vercel Cron (GET), a self-host cron or curl drives JobRunner.tick.
  app.route('/', createJobTickRoutes(deps.jobTick));

  // Defense-in-depth (symmetric with the tRPC maskInternalError): an unexpected
  // throw surfaces as a fixed generic 500 — never a vendor/SQL/token detail.
  app.onError((_error, c) => c.text('Internal server error', 500));

  return app;
}

/** Production fetch handler — mounted by the App Router at app/api/ext/[[...route]]/route.ts. */
export async function extHandler(request: Request): Promise<Response> {
  // The execution loop (/callback, /executor/generic) has no external dependency,
  // so the ext surface is always built. GitHub integration is optional: when it's
  // unconfigured, those deps are undefined and the GitHub routes self-gate (503).
  const integration = getIntegration();
  const execution = getExecution();
  const env = getEnv();
  const tickSecrets = [env.CRON_SECRET, env.JOBS_TICK_SECRET].filter(secret => secret !== undefined);
  const services = getServices();
  const discordInstall = getNotification().install;
  const app = createExtApp({
    auth: services.auth,
    connection: integration?.connection,
    provider: integration?.provider,
    commitSync: integration?.commitSync,
    deliveries: integration?.deliveries,
    runs: execution.runs,
    broker: getCredential().broker,
    versionChecks: getOtaDomain().versionChecks,
    callbackUrl: execution.callbackUrl,
    postJson,
    // Undefined here → the webhook route 503s, mirroring the integration-unconfigured 503.
    webhookSecret: env.GITHUB_WEBHOOK_SECRET,
    waitUntil,
    jobTick:
      tickSecrets.length > 0
        ? {
            runner: getJobRunner(),
            secrets: tickSecrets,
            // Clamped so a misconfigured budget can't outlast the function (JobTiming).
            budgetMs: Math.min(env.JOBS_TICK_BUDGET_MS, JobTiming.maxTickBudgetMs),
            maxJobs: DEFAULT_TICK_MAX_JOBS,
          }
        : undefined,
    inbound: getInbound()?.inbound,
    discord: discordInstall === undefined ? undefined : { install: discordInstall, workspace: services.workspace },
  });
  return await app.fetch(request);
}
