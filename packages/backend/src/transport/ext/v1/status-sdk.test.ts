// The SDK's `status.*` namespace (#159) end to end: @mocco/sdk-core's StatusClient against the real
// Hono /v1 app on pglite. Monitors as code from a script (upserted by key, the second run
// `unchanged`), an incident's lifecycle, a maintenance window, a component status, and the
// refusals a script sees as MoccoError codes.
import { randomUUID } from 'node:crypto';

import { ApiKeyKinds, ApiScopes } from '@mocco/common/apikey';
import { LocationKinds } from '@mocco/common/status';
import { MoccoClient, MoccoError } from '@mocco/sdk-core';
import { StatusClient } from '@mocco/sdk-core/status';
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
import { users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { createV1Routes } from '@backend/transport/ext/v1/routes';
import { statusApiDepsOf } from '@backend/transport/ext/v1/status';

import type { ApiKeyService } from '@backend/domain/apikey/ApiKeyService';
import type { StatusDomain } from '@backend/domain/status/compose';
import type { StatusScope } from '@backend/domain/status/scope';
import type { V1Env } from '@backend/transport/ext/v1/middleware';
import type { ApiScope } from '@mocco/common/apikey';
import type { StatusMonitorInput } from '@mocco/sdk-core/status';

const BASE = 'https://www.mocco.test/api/ext/v1';
const HOUR_MS = 3_600_000;

describe('the SDK status namespace against /v1 (pglite)', () => {
  let t: TestDb;
  let apiKeys: ApiKeyService;
  let status: StatusDomain;
  let app: Hono<V1Env>;
  let scope: StatusScope;
  let userId: string;

  /** A StatusClient whose fetch is the ext app itself. */
  const sdkWith = async (scopes: ApiScope[]) => {
    const { token } = await apiKeys.create(scope.workspaceId, scope.projectId, userId, {
      kind: ApiKeyKinds.secret,
      name: 'ci',
      scopes,
      expiresAt: null,
      flagEnvironmentId: null,
    });
    const client = new MoccoClient({
      key: token,
      baseUrl: BASE,
      isBrowser: false,
      sleep: async () => {},
      fetch: async (input, init) => await app.request(input instanceof Request ? input : String(input), init),
    });
    return new StatusClient(client);
  };

  beforeEach(async () => {
    t = await createTestDb();
    const audit = new AuditService({ audit: new AuditRepo(t.db) });
    const { projects } = createProjectDomain(t.db);
    apiKeys = createApiKeyService(t.db, { projects, audit });
    status = createStatusDomain(t.db, { audit });
    userId = expectOne(
      await t.db
        .insert(users)
        .values({ id: randomUUID(), name: 'Ada', email: `${randomUUID()}@acme.test`, emailVerified: true })
        .returning(),
    ).id;
    const workspaceId = expectOne(
      await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning(),
    ).id;
    const project = await projects.create(workspaceId, { name: 'Acme', handle: 'acme' });
    scope = { workspaceId, projectId: project.id };
    await new LocationRepo(t.db).insert({
      workspaceId: null,
      code: 'fra',
      name: 'Frankfurt',
      kind: LocationKinds.hosted,
      tokenHash: hashLocationToken(generateLocationToken()),
    });
    app = new Hono<V1Env>()
      .basePath('/api/ext')
      .route('/v1', createV1Routes({ apiKeys, limiter: new MemoryRateLimiter(), status: statusApiDepsOf(status) }));
  });
  afterEach(async () => {
    await t.close();
  });

  it('declares monitors as code: created once, then unchanged, then updated', async () => {
    const sdk = await sdkWith([ApiScopes.statusRead, ApiScopes.statusWrite]);
    const page = await status.statusPages.createPage(scope, userId, { slug: 'acme', title: 'Acme' });
    const component = await status.statusPages.createComponent(scope, page.id, { name: 'API' });
    const declared: StatusMonitorInput = {
      name: 'API health',
      spec: { kind: 'http', url: 'https://api.acme.test/health', expectedStatus: [200] },
      locationIds: await sdk.locations.idsOf(['fra']),
      components: [{ componentId: component.id, impactWhenDown: 'major_outage' }],
    };

    const first = await sdk.monitors.upsert('api-health', declared);
    const again = await sdk.monitors.upsert('api-health', declared);
    const changed = await sdk.monitors.upsert('api-health', { ...declared, intervalSeconds: 120 });

    expect(first).toMatchObject({ outcome: 'created', monitor: { key: 'api-health', target: 'api.acme.test' } });
    expect(again).toEqual({ ...first, outcome: 'unchanged' });
    expect(changed.monitor).toMatchObject({ id: first.monitor.id, intervalSeconds: 120 });
    expect(await sdk.monitors.list()).toEqual([changed.monitor]);
    expect(await sdk.monitors.get(first.monitor.id)).toEqual(changed.monitor);

    expect(await sdk.monitors.pause(first.monitor.id)).toMatchObject({ state: 'paused' });
    await expect(sdk.monitors.check(first.monitor.id)).rejects.toMatchObject({ status: 409, code: 'conflict' });
    expect(await sdk.monitors.resume(first.monitor.id)).toMatchObject({ state: 'pending' });
    expect(await sdk.monitors.check(first.monitor.id)).toMatchObject({ monitorId: first.monitor.id });
    await sdk.monitors.delete(first.monitor.id);
    await expect(sdk.monitors.get(first.monitor.id)).rejects.toMatchObject({ status: 404, code: 'not_found' });

    const heartbeat = await sdk.monitors.upsert('nightly', { name: 'Nightly', spec: { kind: 'heartbeat' } });
    expect(heartbeat.heartbeatToken).toMatch(/^mhb_/u);
  });

  it('runs an incident, a maintenance window and a component status from a script', async () => {
    const sdk = await sdkWith([ApiScopes.statusRead, ApiScopes.statusWrite]);
    const page = await status.statusPages.createPage(scope, userId, { slug: 'acme', title: 'Acme' });
    const component = await status.statusPages.createComponent(scope, page.id, { name: 'API' });

    const [listed] = await sdk.pages.list();
    expect(listed).toMatchObject({ id: page.id, slug: 'acme' });
    const opened = await sdk.incidents.create({
      pageId: page.id,
      title: 'Elevated API errors',
      severity: 'major',
      body: 'Looking into it.',
      components: [{ componentId: component.id, impact: 'partial_outage' }],
    });
    const [shown] = await sdk.components.list(page.id);
    expect(shown?.displayedStatus).toBe('partial_outage');

    const { incident } = await sdk.incidents.update(opened.incident.id, { status: 'resolved', body: 'Rolled back.' });
    expect(incident).toMatchObject({ status: 'resolved', resolvedAt: expect.any(String) });
    await expect(sdk.incidents.update(opened.incident.id, { status: 'monitoring', body: 'Hm.' })).rejects.toMatchObject(
      { status: 409, code: 'conflict' },
    );
    expect(await sdk.incidents.list(page.id, { open: true })).toEqual([]);
    const cleared = await sdk.incidents.setComponents(opened.incident.id, []);
    expect(cleared.components).toEqual([]);
    const detail = await sdk.incidents.get(opened.incident.id);
    expect(detail.updates.map(update => update.body)).toEqual(['Looking into it.', 'Rolled back.']);

    const start = new Date(Date.now() + HOUR_MS);
    const window = await sdk.maintenances.schedule({
      pageId: page.id,
      title: 'Database upgrade',
      scheduledStart: start,
      scheduledEnd: new Date(start.getTime() + HOUR_MS),
      componentIds: [component.id],
    });
    expect(window).toMatchObject({ status: 'scheduled', scheduledStart: start.toISOString() });
    expect(await sdk.maintenances.cancel(window.id)).toMatchObject({ status: 'canceled' });
    expect(await sdk.maintenances.list(page.id)).toEqual([expect.objectContaining({ id: window.id })]);

    expect(await sdk.components.setStatus(component.id, 'degraded')).toMatchObject({
      status: 'degraded',
      displayedStatus: 'degraded',
    });
  });

  it("surfaces a key without the scope as MoccoError's insufficient_scope", async () => {
    const reader = await sdkWith([ApiScopes.statusRead]);
    const writer = await sdkWith([ApiScopes.statusWrite]);

    const refused = reader.monitors.upsert('api', { name: 'Nightly', spec: { kind: 'heartbeat' } });
    await expect(refused).rejects.toBeInstanceOf(MoccoError);
    await expect(refused).rejects.toMatchObject({ status: 403, code: 'insufficient_scope' });
    await expect(writer.monitors.list()).rejects.toMatchObject({ status: 403, code: 'insufficient_scope' });
    expect(await reader.monitors.list()).toEqual([]);
  });
});
