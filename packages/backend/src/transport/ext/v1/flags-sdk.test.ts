// End to end: the Node OpenFeature provider against the real /v1 routes on pglite. What
// the server compiles is what the SDK evaluates, and a console change reaches it on the
// next poll.
import { randomUUID } from 'node:crypto';

import { ApiKeyKinds, ApiScopes } from '@mocco/common/apikey';
import { MoccoProvider } from '@mocco/openfeature-server';
import { OpenFeature } from '@openfeature/server-sdk';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApiKeyService } from '@backend/domain/apikey/instance';
import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { FlagService } from '@backend/domain/flags/FlagService';
import { createProjectDomain } from '@backend/domain/project/instance';
import { MemoryRateLimiter } from '@backend/domain/ratelimit/MemoryRateLimiter';
import { expectOne } from '@backend/infra/db/rows';
import { users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { createV1Routes } from '@backend/transport/ext/v1/routes';

import type { V1Env } from '@backend/transport/ext/v1/middleware';

const BASE_URL = 'https://www.mocco.test/api/ext/v1';

describe('@mocco/openfeature-server against /v1/flags/ruleset (pglite)', () => {
  let t: TestDb;

  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await OpenFeature.clearProviders();
    await t.close();
  });

  it('evaluates what the server compiled, and picks up a change on the next poll', async () => {
    const audit = new AuditService({ audit: new AuditRepo(t.db) });
    const { projects } = createProjectDomain(t.db);
    const apiKeys = createApiKeyService(t.db, { projects, audit });
    const flags = new FlagService({ db: t.db, audit });
    const app = new Hono<V1Env>()
      .basePath('/api/ext')
      .route('/v1', createV1Routes({ apiKeys, limiter: new MemoryRateLimiter(), flags: { flags } }));
    const workspaceId = expectOne(
      await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning(),
    ).id;
    const userId = expectOne(
      await t.db
        .insert(users)
        .values({ email: `${randomUUID()}@acme.test` })
        .returning(),
    ).id;
    const { id: projectId } = await projects.create(workspaceId, { name: 'Acme', handle: 'acme' });
    const production = await flags.createEnvironment(workspaceId, projectId, userId, {
      key: 'production',
      name: 'Production',
    });
    await flags.createBooleanFlag(workspaceId, projectId, userId, {
      key: 'new-checkout',
      description: null,
      lifecycle: 'temporary',
    });
    const { token } = await apiKeys.create(workspaceId, projectId, userId, {
      kind: ApiKeyKinds.secret,
      name: 'server',
      scopes: [ApiScopes.flagsRead],
      expiresAt: null,
      flagEnvironmentId: production.id,
    });
    const statuses: number[] = [];
    const fetchThroughApp = async (input: string | URL | Request, init?: RequestInit) => {
      const response = await app.fetch(new Request(input, init));
      statuses.push(response.status);
      return response;
    };

    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const provider = new MoccoProvider({
        secretKey: token,
        baseUrl: BASE_URL,
        fetch: fetchThroughApp,
        pollIntervalMs: 1000,
      });
      await OpenFeature.setProviderAndWait('flags-e2e', provider);
      const client = OpenFeature.getClient('flags-e2e');

      const before = await client.getBooleanDetails('new-checkout', false);
      await vi.advanceTimersByTimeAsync(1000);
      await flags.applyChangeset(workspaceId, projectId, userId, {
        environmentId: production.id,
        baseVersion: 1,
        ops: [{ op: 'set_enabled', flagKey: 'new-checkout', enabled: true }],
        reason: null,
      });
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(async () => {
        expect(await client.getBooleanValue('new-checkout', false)).toBe(true);
      });
      const after = await client.getBooleanDetails('new-checkout', false);

      // Disabled: the code default with reason DISABLED; then on: the flag's own value.
      expect(before).toMatchObject({ value: false, reason: 'DISABLED' });
      expect(after).toMatchObject({
        value: true,
        variant: 'on',
        reason: 'STATIC',
        flagMetadata: { 'mocco.environment': 'production', 'mocco.version': 2 },
      });
      expect(statuses.slice(0, 3)).toEqual([200, 304, 200]);
    } finally {
      vi.useRealTimers();
    }
  });
});
