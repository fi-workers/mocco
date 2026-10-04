// /v1/probe over HTTP: location-token auth, and a lease → results → heartbeat round trip in
// which one location's token can't report another location's lease. The leasing and matching
// rules themselves are pinned in domain/status/probe.test.ts.
import { randomUUID } from 'node:crypto';

import { MonitorKinds, monitorInputSchema } from '@mocco/common/status';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApiKeyService } from '@backend/domain/apikey/instance';
import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { createProjectDomain } from '@backend/domain/project/instance';
import { MemoryRateLimiter } from '@backend/domain/ratelimit/MemoryRateLimiter';
import { CheckResultRetention } from '@backend/domain/status/CheckResultRetention';
import { createStatusDomain } from '@backend/domain/status/compose';
import { expectOne } from '@backend/infra/db/rows';
import { statusCheckResults, statusLocations, users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { createV1Routes } from '@backend/transport/ext/v1/routes';

import type { V1Env } from '@backend/transport/ext/v1/middleware';

const T0 = new Date('2026-10-05T09:00:00.000Z');
const URL_BASE = 'https://www.mocco.test/api/ext/v1/probe';

describe('/v1/probe (pglite)', () => {
  let t: TestDb;
  let app: Hono<V1Env>;
  let clock: Date;
  let officeToken: string;
  let labToken: string;
  let officeId: string;
  let monitorId: string;

  const post = async (path: string, token: string | undefined, body: unknown) =>
    await app.request(`${URL_BASE}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token !== undefined && { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(body),
    });

  beforeEach(async () => {
    t = await createTestDb();
    clock = T0;
    const audit = new AuditService({ audit: new AuditRepo(t.db) });
    const status = createStatusDomain(t.db, { audit, now: () => clock });
    const { projects } = createProjectDomain(t.db);
    const workspaceId = expectOne(
      await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning(),
    ).id;
    const actor = expectOne(
      await t.db
        .insert(users)
        .values({ email: `${randomUUID()}@acme.test`, name: 'Ada' })
        .returning(),
    ).id;
    const project = await projects.create(workspaceId, { name: 'Acme', handle: 'acme' });
    const office = await status.statusLocations.create(workspaceId, actor, { code: 'office', name: 'Office' });
    const lab = await status.statusLocations.create(workspaceId, actor, { code: 'lab', name: 'Lab' });
    officeToken = office.token;
    labToken = lab.token;
    officeId = office.location.id;
    const created = await status.statusMonitors.create(
      { workspaceId, projectId: project.id },
      actor,
      monitorInputSchema.parse({
        name: 'API',
        spec: { kind: MonitorKinds.tcp, host: 'db.internal', port: 5432 },
        locationIds: [office.location.id, lab.location.id],
      }),
    );
    monitorId = created.id;
    await new CheckResultRetention({ db: t.db }).run(T0);
    app = new Hono<V1Env>().basePath('/api/ext').route(
      '/v1',
      createV1Routes({
        apiKeys: createApiKeyService(t.db, { projects, audit }),
        limiter: new MemoryRateLimiter(),
        probe: { probes: status.statusProbes },
      }),
    );
  });
  afterEach(async () => {
    await t.close();
  });

  it('refuses a missing, unknown or disabled location token with 401', async () => {
    const lease = { agentVersion: '1.0.0' };

    const missing = await post('/lease', undefined, lease);
    const unknown = await post('/lease', 'mpl_not-a-real-token', lease);
    await t.db.update(statusLocations).set({ disabledAt: T0 });
    const disabled = await post('/heartbeat', officeToken, lease);

    expect([missing.status, unknown.status, disabled.status]).toEqual([401, 401, 401]);
    expect(await unknown.json()).toMatchObject({ type: 'https://mocco.dev/problems/invalid_location_token' });
  });

  it('leases, accepts its own results, and rejects another location forging them', async () => {
    const leaseResponse = await post('/lease', officeToken, { agentVersion: '1.0.0', capacity: 10 });
    expect(leaseResponse.status).toBe(200);
    const { leases, pollAfterMs } = (await leaseResponse.json()) as {
      leases: { leaseId: string; monitorId: string; roundAt: string; spec: unknown }[];
      pollAfterMs: number;
    };
    expect(pollAfterMs).toBe(15_000);
    expect(leases).toEqual([
      {
        leaseId: expect.any(String),
        monitorId,
        roundAt: T0.toISOString(),
        expiresAt: new Date(T0.getTime() + 25_000).toISOString(),
        spec: { kind: MonitorKinds.tcp, host: 'db.internal', port: 5432, timeoutMs: 10_000 },
      },
    ]);
    const [lease] = leases;
    const result = {
      leaseId: lease?.leaseId,
      monitorId,
      roundAt: lease?.roundAt,
      outcome: 'fail',
      errorKind: 'connect',
    };

    const forged = await post('/results', labToken, { results: [result] });
    const own = await post('/results', officeToken, { results: [result] });
    const malformed = await post('/results', officeToken, { results: [{ ...result, outcome: 'no_data' }] });

    expect(forged.status).toBe(202);
    expect(await forged.json()).toEqual({ accepted: 0, duplicates: 0, rejected: [lease?.leaseId] });
    expect(await own.json()).toEqual({ accepted: 1, duplicates: 0, rejected: [] });
    expect(malformed.status).toBe(400);
    const stored = await t.db.select().from(statusCheckResults);
    expect(stored).toEqual([
      expect.objectContaining({ monitorId, locationId: officeId, outcome: 'fail', errorKind: 'connect' }),
    ]);
  });

  it('records a heartbeat as the location being seen', async () => {
    const response = await post('/heartbeat', officeToken, { agentVersion: '1.4.0', inflight: 2 });

    expect(response.status).toBe(204);
    const rows = await t.db.select().from(statusLocations);
    expect(rows.find(row => row.id === officeId)).toMatchObject({
      agentVersion: '1.4.0',
      lastSeenAt: expect.any(Date),
    });
  });
});
