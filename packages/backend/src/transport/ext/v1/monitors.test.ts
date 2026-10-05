// POST /v1/monitors/:id/check over HTTP (#155): only a secret key with `status:write` of the
// project that owns the monitor gets a round, it is rate limited per key, and a paused monitor
// is refused. The round itself is the evaluator's, like any other.
import { randomUUID } from 'node:crypto';

import { ApiKeyKinds, ApiScopes, apiKeyCreateInputSchema } from '@mocco/common/apikey';
import { LocationKinds, MonitorKinds, MonitorStates, monitorInputSchema } from '@mocco/common/status';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApiKeyService } from '@backend/domain/apikey/instance';
import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { createProjectDomain } from '@backend/domain/project/instance';
import { MemoryRateLimiter } from '@backend/domain/ratelimit/MemoryRateLimiter';
import { createStatusDomain } from '@backend/domain/status/compose';
import { generateLocationToken, hashLocationToken } from '@backend/domain/status/location-token';
import { LocationRepo } from '@backend/domain/status/repos/location.repo';
import { expectOne } from '@backend/infra/db/rows';
import { statusMonitors, users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { MONITOR_CHECK_RATE_LIMIT } from '@backend/transport/ext/v1/monitors';
import { createV1Routes } from '@backend/transport/ext/v1/routes';

import type { ApiKeyService } from '@backend/domain/apikey/ApiKeyService';
import type { StatusDomain } from '@backend/domain/status/compose';
import type { StatusScope } from '@backend/domain/status/scope';
import type { V1Env } from '@backend/transport/ext/v1/middleware';
import type { ApiKeyKind, ApiScope } from '@mocco/common/apikey';

const URL_BASE = 'https://www.mocco.test/api/ext/v1';
const T0 = new Date('2026-10-05T09:00:00.000Z');

describe('POST /v1/monitors/:id/check (pglite)', () => {
  let t: TestDb;
  let apiKeys: ApiKeyService;
  let status: StatusDomain;
  let app: Hono<V1Env>;
  let scope: StatusScope;
  let other: StatusScope;
  let userId: string;
  let locationId: string;
  let clock: Date;

  const check = async (monitorId: string, token?: string) =>
    await app.fetch(
      new Request(`${URL_BASE}/monitors/${monitorId}/check`, {
        method: 'POST',
        headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
      }),
    );

  const statusOf = async (monitorId: string, token?: string) => {
    const response = await check(monitorId, token);
    return response.status;
  };

  const keyOf = async (on: StatusScope, kind: ApiKeyKind, scopes: ApiScope[]) => {
    const { token } = await apiKeys.create(on.workspaceId, on.projectId, userId, {
      kind,
      name: kind,
      scopes,
      expiresAt: null,
      flagEnvironmentId: null,
    });
    return token;
  };

  const newMonitor = async (on: StatusScope) =>
    await status.statusMonitors.create(
      on,
      userId,
      monitorInputSchema.parse({
        name: 'API health',
        spec: { kind: MonitorKinds.http, url: 'https://api.acme.test/health' },
        locationIds: [locationId],
      }),
    );

  const current = async (monitorId: string) =>
    expectOne(await t.db.select().from(statusMonitors).where(eq(statusMonitors.id, monitorId)));

  /** A monitor whose next round is a minute away (its first round closed). */
  const scheduledMonitor = async (on: StatusScope) => {
    const monitor = await newMonitor(on);
    await t.db
      .update(statusMonitors)
      .set({ nextRoundAt: new Date(clock.getTime() + 60_000) })
      .where(eq(statusMonitors.id, monitor.id));
    return monitor;
  };

  beforeEach(async () => {
    t = await createTestDb();
    clock = T0;
    const audit = new AuditService({ audit: new AuditRepo(t.db) });
    const { projects } = createProjectDomain(t.db);
    apiKeys = createApiKeyService(t.db, { projects, audit });
    status = createStatusDomain(t.db, { audit, now: () => clock });
    userId = expectOne(
      await t.db
        .insert(users)
        .values({ id: randomUUID(), name: 'Ada', email: `${randomUUID()}@acme.test`, emailVerified: true })
        .returning(),
    ).id;
    const workspaceId = expectOne(
      await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning(),
    ).id;
    const acme = await projects.create(workspaceId, { name: 'Acme', handle: 'acme' });
    const blog = await projects.create(workspaceId, { name: 'Blog', handle: 'blog' });
    scope = { workspaceId, projectId: acme.id };
    other = { workspaceId, projectId: blog.id };
    const location = await new LocationRepo(t.db).insert({
      workspaceId: null,
      code: 'fra',
      name: 'fra',
      kind: LocationKinds.hosted,
      tokenHash: hashLocationToken(generateLocationToken()),
    });
    locationId = location.id;
    app = new Hono<V1Env>().basePath('/api/ext').route(
      '/v1',
      createV1Routes({
        apiKeys,
        limiter: new MemoryRateLimiter(),
        monitors: { monitors: status.statusMonitors },
      }),
    );
  });
  afterEach(async () => {
    await t.close();
  });

  it('pulls the next round to now and answers with its time', async () => {
    const monitor = await scheduledMonitor(scope);
    const token = await keyOf(scope, ApiKeyKinds.secret, [ApiScopes.statusWrite]);

    const response = await check(monitor.id, token);

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ monitorId: monitor.id, roundAt: T0.toISOString() });
    expect(await current(monitor.id)).toMatchObject({ nextRoundAt: T0, state: MonitorStates.pending });

    // A round already due stays as it is: asking again later answers with the same round.
    clock = new Date(T0.getTime() + 5000);
    const again = await check(monitor.id, token);
    expect(await again.json()).toEqual({ monitorId: monitor.id, roundAt: T0.toISOString() });
  });

  it('refuses no key, a key without status:write, and a publishable key', async () => {
    const monitor = await scheduledMonitor(scope);
    const before = await current(monitor.id);

    const missing = await check(monitor.id);
    expect(missing.status).toBe(401);
    const reader = await check(monitor.id, await keyOf(scope, ApiKeyKinds.secret, [ApiScopes.runsRead]));
    expect(reader.status).toBe(403);
    expect(await reader.json()).toMatchObject({ type: expect.stringContaining('insufficient_scope') });
    // The console can't give a publishable key the scope, and the route refuses one that has it.
    const publishable = { kind: ApiKeyKinds.publishable, name: 'app', scopes: [ApiScopes.statusWrite] };
    expect(apiKeyCreateInputSchema.safeParse(publishable).success).toBe(false);
    expect(apiKeyCreateInputSchema.safeParse({ ...publishable, kind: ApiKeyKinds.secret }).success).toBe(true);
    const fromApp = await check(monitor.id, await keyOf(scope, ApiKeyKinds.publishable, [ApiScopes.statusWrite]));
    expect(fromApp.status).toBe(403);
    expect(await fromApp.json()).toMatchObject({ type: expect.stringContaining('wrong_key_kind') });

    expect(await current(monitor.id)).toEqual(before);
  });

  it("answers 404 for another project's key, another project's monitor, and an unknown id", async () => {
    const mine = await scheduledMonitor(scope);
    const theirs = await scheduledMonitor(other);
    const token = await keyOf(scope, ApiKeyKinds.secret, [ApiScopes.statusWrite]);
    const otherToken = await keyOf(other, ApiKeyKinds.secret, [ApiScopes.statusWrite]);
    const before = [await current(mine.id), await current(theirs.id)];

    expect(await statusOf(mine.id, otherToken)).toBe(404);
    expect(await statusOf(theirs.id, token)).toBe(404);
    expect(await statusOf(randomUUID(), token)).toBe(404);
    expect(await statusOf('not-a-uuid', token)).toBe(404);

    expect([await current(mine.id), await current(theirs.id)]).toEqual(before);
  });

  it('refuses a paused monitor with 409', async () => {
    const monitor = await scheduledMonitor(scope);
    await status.statusMonitors.pause(scope, userId, monitor.id);
    const before = await current(monitor.id);

    const response = await check(monitor.id, await keyOf(scope, ApiKeyKinds.secret, [ApiScopes.statusWrite]));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ type: expect.stringContaining('conflict') });
    expect(await current(monitor.id)).toEqual(before);
  });

  it('limits checks per key', async () => {
    const monitor = await scheduledMonitor(scope);
    const token = await keyOf(scope, ApiKeyKinds.secret, [ApiScopes.statusWrite]);

    const answers = await Array.from({ length: MONITOR_CHECK_RATE_LIMIT.limit + 1 }).reduce<Promise<number[]>>(
      async (previous, _unused) => [...(await previous), await statusOf(monitor.id, token)],
      Promise.resolve([]),
    );

    expect(answers.slice(0, -1).every(code => code === 202)).toBe(true);
    expect(answers.at(-1)).toBe(429);
    // Another key of the project has its own budget.
    const fresh = await keyOf(scope, ApiKeyKinds.secret, [ApiScopes.statusWrite]);
    expect(await statusOf(monitor.id, fresh)).toBe(202);
  });
});
