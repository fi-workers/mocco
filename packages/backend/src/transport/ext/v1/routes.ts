// The public /v1 routes (ADR 0017), mounted by transport/ext/app.ts at /api/ext/v1 (and,
// with PUBLIC_API_DOMAIN set, at https://<that host>/v1). Product routes join here as
// their slices land; each takes a key with `requireKey` and scopes by `c.var.principal`.
import { Hono } from 'hono';

import { createFlagServingRoutes } from '@backend/transport/ext/v1/flags';
import { createHeartbeatPingRoutes } from '@backend/transport/ext/v1/heartbeat-ping';
import { createHelpRoutes } from '@backend/transport/ext/v1/help';
import { createMessengerRoutes } from '@backend/transport/ext/v1/messenger';
import { cors, limitAnonymous, requireKey, type V1Deps, type V1Env } from '@backend/transport/ext/v1/middleware';
import { createMonitorCheckRoutes } from '@backend/transport/ext/v1/monitors';
import { createOfrepRoutes } from '@backend/transport/ext/v1/ofrep';
import { createOtaServingRoutes } from '@backend/transport/ext/v1/ota-manifest';
import { createOtaUploadRoutes } from '@backend/transport/ext/v1/ota-uploads';
import { createProbeRoutes } from '@backend/transport/ext/v1/probe';
import { createRunReadRoutes } from '@backend/transport/ext/v1/runs';
import { createStatusApiRoutes } from '@backend/transport/ext/v1/status';
import { createStatusOpenApiRoutes } from '@backend/transport/ext/v1/status-openapi';
import { createStatusSubscriberRoutes } from '@backend/transport/ext/v1/status-subscribers';

export function createV1Routes(deps: V1Deps): Hono<V1Env> {
  const app = new Hono<V1Env>();
  app.use('*', cors);

  // Liveness for SDKs and uptime checks. No key.
  app.get('/ping', limitAnonymous(deps), c => c.json({ ok: true, api: 'v1' }));

  // Which project and scopes a key speaks for — lets an SDK verify its configuration.
  app.get('/whoami', requireKey(deps), c => {
    const { projectId, kind, scopes } = c.var.principal;
    return c.json({ projectId, kind, scopes });
  });

  if (deps.ota !== undefined) {
    app.route('/ota', createOtaServingRoutes(deps, deps.ota));
    app.route('/ota', createOtaUploadRoutes(deps, deps.ota));
  }

  if (deps.runs !== undefined) {
    app.route('/', createRunReadRoutes(deps, deps.runs));
  }

  if (deps.messenger !== undefined) {
    app.route('/messenger', createMessengerRoutes(deps, deps.messenger));
  }

  if (deps.help !== undefined) {
    app.route('/help', createHelpRoutes(deps, deps.help));
  }

  if (deps.flags !== undefined) {
    app.route('/flags', createFlagServingRoutes(deps, deps.flags));
    app.route('/ofrep/v1', createOfrepRoutes(deps, deps.flags));
  }

  if (deps.status !== undefined) {
    app.route('/monitors', createMonitorCheckRoutes(deps, deps.status));
    app.route('/', createStatusApiRoutes(deps, deps.status));
    app.route('/status', createStatusOpenApiRoutes(deps));
  }

  // Heartbeat pings (#153): the path's token is the credential, no key.
  if (deps.heartbeats !== undefined) {
    app.route('/ping', createHeartbeatPingRoutes(deps, deps.heartbeats));
  }

  // Status page subscribers (#156): the public slug and signed links, no key.
  if (deps.statusSubscribers !== undefined) {
    app.route('/status-pages', createStatusSubscriberRoutes(deps, deps.statusSubscribers));
  }

  if (deps.probe !== undefined) {
    app.route('/probe', createProbeRoutes(deps, deps.probe));
  }

  return app;
}
