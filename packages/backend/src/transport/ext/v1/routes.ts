// The public /v1 routes (ADR 0017), mounted by transport/ext/app.ts at /api/ext/v1 (and,
// with PUBLIC_API_DOMAIN set, at https://<that host>/v1). Product routes join here as
// their slices land; each takes a key with `requireKey` and scopes by `c.var.principal`.
import { Hono } from 'hono';

import { cors, limitAnonymous, requireKey, type V1Deps, type V1Env } from '@backend/transport/ext/v1/middleware';

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

  return app;
}
