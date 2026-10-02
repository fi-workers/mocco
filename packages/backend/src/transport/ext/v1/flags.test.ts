import { randomUUID } from 'node:crypto';

import { ApiKeyKinds, ApiScopes } from '@mocco/common/apikey';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApiKeyService } from '@backend/domain/apikey/instance';
import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { FlagService } from '@backend/domain/flags/FlagService';
import { flagdValidator } from '@backend/domain/flags/testing/flagd-schema';
import { createProjectDomain } from '@backend/domain/project/instance';
import { MemoryRateLimiter } from '@backend/domain/ratelimit/MemoryRateLimiter';
import { expectOne } from '@backend/infra/db/rows';
import { users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { createV1Routes } from '@backend/transport/ext/v1/routes';

import type { ApiKeyService } from '@backend/domain/apikey/ApiKeyService';
import type { V1Env } from '@backend/transport/ext/v1/middleware';
import type { ApiScope } from '@mocco/common/apikey';

const URL_BASE = 'https://www.mocco.test/api/ext/v1';

describe('GET /v1/flags/ruleset (pglite)', () => {
  let t: TestDb;
  let apiKeys: ApiKeyService;
  let flags: FlagService;
  let app: Hono<V1Env>;
  let workspaceId: string;
  let projectId: string;
  let userId: string;
  let stagingId: string;
  let productionId: string;

  beforeEach(async () => {
    t = await createTestDb();
    const audit = new AuditService({ audit: new AuditRepo(t.db) });
    const { projects } = createProjectDomain(t.db);
    apiKeys = createApiKeyService(t.db, { projects, audit });
    flags = new FlagService({ db: t.db, audit });
    const v1 = createV1Routes({ apiKeys, limiter: new MemoryRateLimiter(), flags: { flags } });
    app = new Hono<V1Env>().basePath('/api/ext').route('/v1', v1);
    workspaceId = expectOne(await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning()).id;
    userId = expectOne(
      await t.db
        .insert(users)
        .values({ email: `${randomUUID()}@acme.test` })
        .returning(),
    ).id;
    const project = await projects.create(workspaceId, { name: 'Acme', handle: 'acme' });
    projectId = project.id;
    const staging = await flags.createEnvironment(workspaceId, projectId, userId, { key: 'staging', name: 'Staging' });
    const production = await flags.createEnvironment(workspaceId, projectId, userId, {
      key: 'production',
      name: 'Production',
    });
    stagingId = staging.id;
    productionId = production.id;
    await flags.createBooleanFlag(workspaceId, projectId, userId, {
      key: 'new-checkout',
      description: null,
      lifecycle: 'temporary',
    });
  });
  afterEach(async () => {
    await t.close();
  });

  const keyFor = async (
    environmentId: string | null,
    kind: (typeof ApiKeyKinds)[keyof typeof ApiKeyKinds] = ApiKeyKinds.secret,
    scopes: ApiScope[] = [ApiScopes.flagsRead],
  ) => {
    const { token } = await apiKeys.create(workspaceId, projectId, userId, {
      kind,
      name: 'server',
      scopes,
      expiresAt: null,
      flagEnvironmentId: environmentId,
    });
    return token;
  };
  const fetchRuleset = async (token: string, headers: Record<string, string> = {}) =>
    await app.fetch(
      new Request(`${URL_BASE}/flags/ruleset`, { headers: { authorization: `Bearer ${token}`, ...headers } }),
    );

  it("serves the key's environment as a valid flagd document with an ETag", async () => {
    await flags.applyChangeset(workspaceId, projectId, userId, {
      environmentId: stagingId,
      baseVersion: 1,
      ops: [{ op: 'set_enabled', flagKey: 'new-checkout', enabled: true }],
      reason: null,
    });

    const staging = await fetchRuleset(await keyFor(stagingId));
    const production = await fetchRuleset(await keyFor(productionId));
    const [stagingBody, productionBody] = (await Promise.all([staging.json(), production.json()])) as Record<
      string,
      unknown
    >[];

    expect([staging.status, production.status]).toEqual([200, 200]);
    expect(staging.headers.get('etag')).toMatch(/^"[\w-]+"$/u);
    expect(staging.headers.get('cache-control')).toBe('private, no-cache');
    expect(stagingBody).toMatchObject({
      metadata: { 'mocco.environment': 'staging', 'mocco.version': 2 },
      flags: { 'new-checkout': { state: 'ENABLED' } },
    });
    expect(productionBody).toMatchObject({
      metadata: { 'mocco.environment': 'production' },
      flags: { 'new-checkout': { state: 'DISABLED' } },
    });
    const validate = await flagdValidator();
    expect(validate(stagingBody)).toBe(true);
  });

  it('answers 304 to the current ETag and 200 again once the environment changes', async () => {
    const token = await keyFor(stagingId);
    const first = await fetchRuleset(token);
    const etag = first.headers.get('etag') ?? '';

    const unchanged = await fetchRuleset(token, { 'if-none-match': `"stale", W/${etag}` });
    await flags.applyChangeset(workspaceId, projectId, userId, {
      environmentId: stagingId,
      baseVersion: 1,
      ops: [{ op: 'set_enabled', flagKey: 'new-checkout', enabled: true }],
      reason: null,
    });
    const changed = await fetchRuleset(token, { 'if-none-match': etag });

    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe('');
    expect(unchanged.headers.get('etag')).toBe(etag);
    expect(changed.status).toBe(200);
    expect(changed.headers.get('etag')).not.toBe(etag);
  });

  it('refuses publishable keys, keys without flags:read and browsers', async () => {
    const publishable = await keyFor(stagingId, ApiKeyKinds.publishable);
    const otaOnly = await keyFor(null, ApiKeyKinds.secret, [ApiScopes.otaRead]);
    const secret = await keyFor(stagingId);

    const responses = await Promise.all([
      fetchRuleset(publishable),
      fetchRuleset(otaOnly),
      fetchRuleset(secret, { origin: 'https://app.acme.test' }),
    ]);

    expect(responses.map(response => response.status)).toEqual([403, 403, 401]);
  });

  it('binds a flags:read key to exactly one environment of its own project', async () => {
    const otherProject = await createProjectDomain(t.db).projects.create(workspaceId, {
      name: 'Other',
      handle: 'other',
    });
    const foreign = await flags.createEnvironment(workspaceId, otherProject.id, userId, { key: 'prod', name: 'Prod' });

    await expect(keyFor(foreign.id)).rejects.toThrow(/not found in this project/u);
    await expect(keyFor(stagingId, ApiKeyKinds.secret, [ApiScopes.otaRead])).rejects.toThrow();
  });
});
