import { randomUUID } from 'node:crypto';

import { ApiKeyKinds, ApiScopes } from '@mocco/common/apikey';
import { AppPlatforms } from '@mocco/common/project';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApiKeyService } from '@backend/domain/apikey/instance';
import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { createProjectDomain } from '@backend/domain/project/instance';
import { MemoryRateLimiter } from '@backend/domain/ratelimit/MemoryRateLimiter';
import { expectOne } from '@backend/infra/db/rows';
import { users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { requireKey, type V1Env } from '@backend/transport/ext/v1/middleware';
import { PROBLEM_CONTENT_TYPE } from '@backend/transport/ext/v1/problem';
import { createV1Routes } from '@backend/transport/ext/v1/routes';

import type { ApiKeyService } from '@backend/domain/apikey/ApiKeyService';
import type { RateLimiter } from '@backend/domain/ratelimit/ports';
import type { ApiScope } from '@mocco/common/apikey';

const URL_BASE = 'https://www.mocco.test/api/ext/v1';

describe('/v1 routes (pglite)', () => {
  let t: TestDb;
  let apiKeys: ApiKeyService;
  let workspaceId: string;
  let projectId: string;
  let userId: string;
  let app: Hono<V1Env>;

  const build = (limiter: RateLimiter = new MemoryRateLimiter()) => {
    const deps = { apiKeys, limiter };
    const v1 = createV1Routes(deps);
    // A scoped route, as product routes will declare them.
    v1.get('/scoped', requireKey(deps, { scope: ApiScopes.otaWrite }), c => c.json({ ok: true }));
    v1.get('/secret-only', requireKey(deps, { kinds: [ApiKeyKinds.secret] }), c => c.json({ ok: true }));
    return new Hono<V1Env>().basePath('/api/ext').route('/v1', v1);
  };

  const call = async (path: string, headers: Record<string, string> = {}) =>
    await app.fetch(new Request(`${URL_BASE}${path}`, { headers }));

  const keyOf = async (
    kind: (typeof ApiKeyKinds)[keyof typeof ApiKeyKinds],
    scopes: ApiScope[] = [ApiScopes.flagsRead],
  ) => {
    const { token } = await apiKeys.create(workspaceId, projectId, userId, {
      kind,
      name: kind,
      scopes,
      expiresAt: null,
    });
    return token;
  };

  beforeEach(async () => {
    t = await createTestDb();
    const audit = new AuditService({ audit: new AuditRepo(t.db) });
    const { projects } = createProjectDomain(t.db);
    apiKeys = createApiKeyService(t.db, { projects, audit });
    workspaceId = expectOne(await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning()).id;
    userId = expectOne(
      await t.db
        .insert(users)
        .values({ id: randomUUID(), name: 'Ada', email: `${randomUUID()}@acme.test`, emailVerified: true })
        .returning(),
    ).id;
    const project = await projects.create(workspaceId, { name: 'Acme', handle: 'acme' });
    projectId = project.id;
    await projects.addApp(workspaceId, projectId, {
      platform: AppPlatforms.web,
      name: 'web',
      webOrigins: ['https://app.acme.test'],
    });
    app = build();
  });
  afterEach(async () => {
    await t.close();
  });

  it('answers /v1/ping without a key, with rate-limit headers', async () => {
    const response = await call('/ping');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, api: 'v1' });
    expect(response.headers.get('ratelimit-limit')).toBe('120');
  });

  it('identifies the project a key speaks for', async () => {
    const response = await call('/whoami', { authorization: `Bearer ${await keyOf(ApiKeyKinds.secret)}` });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ projectId, kind: ApiKeyKinds.secret, scopes: [ApiScopes.flagsRead] });
    expect(response.headers.get('ratelimit-limit')).toBe('1200');
  });

  it('refuses a missing or invalid key with a 401 problem', async () => {
    const missing = await call('/whoami');
    const invalid = await call('/whoami', { 'x-mocco-key': `mk_sec_${'B'.repeat(32)}` });

    expect([missing.status, invalid.status]).toEqual([401, 401]);
    expect(missing.headers.get('content-type')).toBe(PROBLEM_CONTENT_TYPE);
    expect(await invalid.json()).toMatchObject({ type: 'https://mocco.dev/problems/invalid_key', status: 401 });
  });

  it('refuses a secret key sent with an Origin (401) and a publishable key from another origin (403)', async () => {
    const secret = await call('/whoami', {
      authorization: `Bearer ${await keyOf(ApiKeyKinds.secret)}`,
      origin: 'https://app.acme.test',
    });
    const publishable = await keyOf(ApiKeyKinds.publishable);
    const foreign = await call('/whoami', { authorization: `Bearer ${publishable}`, origin: 'https://evil.test' });
    const allowed = await call('/whoami', { authorization: `Bearer ${publishable}`, origin: 'https://app.acme.test' });

    expect([secret.status, foreign.status, allowed.status]).toEqual([401, 403, 200]);
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://app.acme.test');
  });

  it('enforces scopes and key kinds per route', async () => {
    const readOnly = await keyOf(ApiKeyKinds.secret, [ApiScopes.flagsRead]);
    const writer = await keyOf(ApiKeyKinds.secret, [ApiScopes.otaWrite]);
    const publishable = await keyOf(ApiKeyKinds.publishable);

    const responses = await Promise.all([
      call('/scoped', { authorization: `Bearer ${readOnly}` }),
      call('/scoped', { authorization: `Bearer ${writer}` }),
      call('/secret-only', { authorization: `Bearer ${publishable}` }),
    ]);

    expect(responses.map(response => response.status)).toEqual([403, 200, 403]);
  });

  it('answers 429 with reset headers once the limit is used up', async () => {
    const exhausted: RateLimiter = {
      consume: async () =>
        await Promise.resolve({ allowed: false, remaining: 0, resetAt: new Date(Date.now() + 30_000) }),
    };
    app = build(exhausted);

    const response = await call('/ping');

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toMatch(/^\d+$/u);
    expect(response.headers.get('ratelimit-remaining')).toBe('0');
    expect(await response.json()).toMatchObject({ type: 'https://mocco.dev/problems/rate_limited' });
  });

  it('answers CORS preflights for any origin', async () => {
    const response = await app.fetch(
      new Request(`${URL_BASE}/whoami`, { method: 'OPTIONS', headers: { origin: 'https://app.acme.test' } }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-headers')).toContain('authorization');
  });
});
