// The public /v1 routes (ADR 0017), mounted by transport/ext/app.ts at /api/ext/v1 (and,
// with PUBLIC_API_DOMAIN set, at https://<that host>/v1). Product routes join here as
// their slices land; each takes a key with `requireKey` and scopes by `c.var.principal`.
import { Hono } from 'hono';

import { createFlagServingRoutes } from '@backend/transport/ext/v1/flags';
import { createHelpRoutes } from '@backend/transport/ext/v1/help';
import { createMessengerRoutes } from '@backend/transport/ext/v1/messenger';
import { cors, limitAnonymous, requireKey, type V1Deps, type V1Env } from '@backend/transport/ext/v1/middleware';
import { createOfrepRoutes } from '@backend/transport/ext/v1/ofrep';
import { createOtaServingRoutes } from '@backend/transport/ext/v1/ota-manifest';
import { createOtaUploadRoutes } from '@backend/transport/ext/v1/ota-uploads';
import { createProbeRoutes } from '@backend/transport/ext/v1/probe';
import { createRunReadRoutes } from '@backend/transport/ext/v1/runs';

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

  if (deps.probe !== undefined) {
    app.route('/probe', createProbeRoutes(deps, deps.probe));
  }

  return app;
}
