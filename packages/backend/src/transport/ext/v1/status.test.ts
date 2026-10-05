// The /v1 status management API over HTTP (#159), on pglite: a monitor upsert by key is
// idempotent, answers carry only the wire fields (never a URL's secrets, a token hash or a
// workspace id), reads need `status:read` and changes `status:write` on a secret key, and
// another project's or workspace's resources answer 404 and stay as they were.
import { randomUUID } from 'node:crypto';

import { ApiKeyKinds, ApiScopes } from '@mocco/common/apikey';
import { AuditActions } from '@mocco/common/audit';
import { ComponentStatuses, IncidentStatuses, LocationKinds, MaintenanceStatuses } from '@mocco/common/status';
import {
  MonitorUpsertOutcomes,
  statusV1ComponentSchema,
  statusV1IncidentDetailSchema,
  statusV1MaintenanceSchema,
  statusV1MonitorListSchema,
  statusV1MonitorSchema,
  statusV1MonitorUpsertResultSchema,
} from '@mocco/common/status-v1';
import { and, eq } from 'drizzle-orm';
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
import { auditLog, statusMonitors, users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { createV1Routes } from '@backend/transport/ext/v1/routes';
import { statusApiDepsOf } from '@backend/transport/ext/v1/status';

import type { ApiKeyService } from '@backend/domain/apikey/ApiKeyService';
import type { StatusDomain } from '@backend/domain/status/compose';
import type { StatusScope } from '@backend/domain/status/scope';
import type { V1Env } from '@backend/transport/ext/v1/middleware';
import type { ApiKeyKind, ApiScope } from '@mocco/common/apikey';
import type { AuditAction } from '@mocco/common/audit';

const BASE = '/api/ext/v1';
const SECRET_URL = 'https://ops:hunter2@api.acme.test:8443/health?token=s3cr3t';
const HOUR_MS = 3_600_000;

type Method = 'GET' | 'PUT' | 'POST' | 'PATCH' | 'DELETE';
type Request = readonly [Method, string, unknown?];

const expected = (requests: readonly Request[], code: number) =>
  requests.map(([method, path]) => `${method} ${path} → ${code}`);
const byText = (a: string, b: string) => Number(a > b) - Number(a < b);

describe('/v1 status management API (pglite)', () => {
  let t: TestDb;
  let apiKeys: ApiKeyService;
  let status: StatusDomain;
  let app: Hono<V1Env>;
  let acme: StatusScope;
  let blog: StatusScope;
  let elsewhere: StatusScope;
  let userId: string;
  let locationId: string;

  /** The answer's status and parsed body (null when it has none). */
  const exchange = async (method: Method, path: string, token?: string, body?: unknown) => {
    const response = await app.request(`${BASE}${path}`, {
      method,
      headers: {
        ...(token !== undefined && { authorization: `Bearer ${token}` }),
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, text, body: (text === '' ? null : JSON.parse(text)) as unknown };
  };
  const bodyOf = async (method: Method, path: string, token?: string, body?: unknown) => {
    const { body: answer } = await exchange(method, path, token, body);
    return answer;
  };
  const statusOf = async (method: Method, path: string, token?: string, body?: unknown) => {
    const { status: code } = await exchange(method, path, token, body);
    return code;
  };
  /** Each request's `METHOD path → status`, for one readable comparison. */
  const statusesOf = async (requests: readonly Request[], token: string) =>
    await Promise.all(
      requests.map(async ([method, path, body]) => `${method} ${path} → ${await statusOf(method, path, token, body)}`),
    );

  const keyOf = async (on: StatusScope, scopes: ApiScope[], kind: ApiKeyKind = ApiKeyKinds.secret) => {
    const { token, key } = await apiKeys.create(on.workspaceId, on.projectId, userId, {
      kind,
      name: 'ci',
      scopes,
      expiresAt: null,
      flagEnvironmentId: null,
    });
    return { token, keyId: key.id };
  };
  const readWrite = async (on: StatusScope) => {
    const { token } = await keyOf(on, [ApiScopes.statusRead, ApiScopes.statusWrite]);
    return token;
  };

  const httpMonitor = (overrides: Record<string, unknown> = {}) => ({
    name: 'API health',
    spec: { kind: 'http', url: SECRET_URL, method: 'POST', body: '{"password":"pw"}', expectedStatus: [200] },
    locationIds: [locationId],
    ...overrides,
  });
  const upsert = async (token: string, key: string, body: unknown) => {
    const answer = await exchange('PUT', `/monitors/by-key/${key}`, token, body);
    return { status: answer.status, result: statusV1MonitorUpsertResultSchema.parse(answer.body) };
  };

  const monitorRows = async (on: StatusScope) =>
    await t.db.select().from(statusMonitors).where(eq(statusMonitors.projectId, on.projectId));
  const auditOf = async (action: AuditAction) =>
    await t.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.workspaceId, acme.workspaceId), eq(auditLog.action, action)));

  const newWorkspace = async () =>
    expectOne(await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning()).id;
  const newProject = async (workspaceId: string, handle: string) => {
    const { projects } = createProjectDomain(t.db);
    const project = await projects.create(workspaceId, { name: handle, handle });
    return { workspaceId, projectId: project.id };
  };

  const pageWithComponent = async (on: StatusScope, slug: string) => {
    const page = await status.statusPages.createPage(on, userId, { slug, title: 'Acme status' });
    const component = await status.statusPages.createComponent(on, page.id, { name: 'API' });
    return { pageId: page.id, componentId: component.id };
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
    const workspaceId = await newWorkspace();
    acme = await newProject(workspaceId, 'acme');
    blog = await newProject(workspaceId, 'blog');
    elsewhere = await newProject(await newWorkspace(), 'acme');
    const location = await new LocationRepo(t.db).insert({
      workspaceId: null,
      code: 'fra',
      name: 'Frankfurt',
      kind: LocationKinds.hosted,
      tokenHash: hashLocationToken(generateLocationToken()),
    });
    locationId = location.id;
    app = new Hono<V1Env>()
      .basePath('/api/ext')
      .route('/v1', createV1Routes({ apiKeys, limiter: new MemoryRateLimiter(), status: statusApiDepsOf(status) }));
  });
  afterEach(async () => {
    await t.close();
  });

  describe('monitor upsert by key', () => {
    it('creates once, then answers unchanged without writing or auditing again', async () => {
      const { token, keyId } = await keyOf(acme, [ApiScopes.statusWrite]);

      const first = await upsert(token, 'api-health', httpMonitor());
      expect(first.status).toBe(201);
      expect(first.result).toMatchObject({ outcome: MonitorUpsertOutcomes.created, heartbeatToken: null });
      expect(first.result.monitor).toMatchObject({ key: 'api-health', name: 'API health', locationIds: [locationId] });
      const before = await monitorRows(acme);

      const again = await upsert(token, 'api-health', httpMonitor());
      expect(again.status).toBe(200);
      expect(again.result.outcome).toBe(MonitorUpsertOutcomes.unchanged);
      expect(again.result.monitor).toEqual(first.result.monitor);
      expect(await monitorRows(acme)).toEqual(before);
      expect(await auditOf(AuditActions.statusMonitorUpdated)).toEqual([]);

      // The key acts for the person who created it, and the log names the key.
      const created = await auditOf(AuditActions.statusMonitorCreated);
      expect(created).toEqual([
        expect.objectContaining({
          actorUserId: userId,
          payload: expect.objectContaining({ key: 'api-health', principal: `apikey:${keyId}` }),
        }),
      ]);
    });

    it('changes a monitor that differs, keeps its id, and refuses a switch to a heartbeat', async () => {
      const token = await readWrite(acme);
      const first = await upsert(token, 'api-health', httpMonitor());

      const changed = await upsert(token, 'api-health', httpMonitor({ intervalSeconds: 300 }));
      expect(changed.status).toBe(200);
      expect(changed.result.outcome).toBe(MonitorUpsertOutcomes.updated);
      expect(changed.result.monitor).toMatchObject({ id: first.result.monitor.id, intervalSeconds: 300 });
      expect(await auditOf(AuditActions.statusMonitorUpdated)).toHaveLength(1);

      const heartbeat = { name: 'API health', spec: { kind: 'heartbeat', periodSeconds: 3600 } };
      expect(await statusOf('PUT', '/monitors/by-key/api-health', token, heartbeat)).toBe(409);
      expect(await monitorRows(acme)).toHaveLength(1);
    });

    // pglite runs one transaction at a time, so this checks the end state; the unique-index retry
    // in upsertByKey is for Postgres, where both can miss the key and insert.
    it('makes one monitor when two upserts of a new key arrive together', async () => {
      const token = await readWrite(acme);

      const answers = await Promise.all([
        upsert(token, 'api-health', httpMonitor()),
        upsert(token, 'api-health', httpMonitor()),
      ]);

      expect(answers.map(answer => answer.result.outcome).toSorted(byText)).toEqual([
        MonitorUpsertOutcomes.created,
        MonitorUpsertOutcomes.unchanged,
      ]);
      expect(await monitorRows(acme)).toHaveLength(1);
    });

    it("gives a new heartbeat's ping token once", async () => {
      const token = await readWrite(acme);
      const heartbeat = { name: 'Nightly backup', spec: { kind: 'heartbeat', periodSeconds: 86_400 } };

      const first = await upsert(token, 'nightly-backup', heartbeat);
      const again = await upsert(token, 'nightly-backup', heartbeat);

      expect(first.result.heartbeatToken).toMatch(/^mhb_/u);
      expect(first.result.monitor.heartbeat).toMatchObject({ periodSeconds: 86_400, lastPingAt: null });
      expect(again.result).toMatchObject({ outcome: MonitorUpsertOutcomes.unchanged, heartbeatToken: null });
    });

    it('refuses a bad key and a bad body, and an unknown location or component', async () => {
      const token = await readWrite(acme);
      const components = [{ componentId: randomUUID(), impactWhenDown: ComponentStatuses.majorOutage }];

      expect(
        await statusesOf(
          [
            ['PUT', '/monitors/by-key/API%20Health', httpMonitor()],
            ['PUT', '/monitors/by-key/api', { name: 'x' }],
          ],
          token,
        ),
      ).toEqual(['PUT /monitors/by-key/API%20Health → 400', 'PUT /monitors/by-key/api → 400']);
      expect(await statusOf('PUT', '/monitors/by-key/api', token, httpMonitor({ locationIds: [randomUUID()] }))).toBe(
        404,
      );
      expect(await statusOf('PUT', '/monitors/by-key/api', token, httpMonitor({ components }))).toBe(404);
      expect(await monitorRows(acme)).toEqual([]);
    });
  });

  it("never answers a URL's credentials, path or query, a request body, a token hash or a workspace id", async () => {
    const token = await readWrite(acme);
    await upsert(token, 'api-health', httpMonitor());
    await upsert(token, 'backup', { name: 'Backup', spec: { kind: 'heartbeat' } });

    const list = await exchange('GET', '/monitors', token);

    expect(list.status).toBe(200);
    expect(
      ['hunter2', 'ops:', 's3cr3t', '/health', 'password', 'TokenHash', 'workspaceId'].filter(secret =>
        list.text.includes(secret),
      ),
    ).toEqual([]);
    const { monitors } = statusV1MonitorListSchema.parse(list.body);
    const fields = Object.keys(statusV1MonitorSchema.shape).toSorted(byText);
    const raw = (list.body as { monitors: Record<string, unknown>[] }).monitors;
    expect(raw.map(monitor => Object.keys(monitor).toSorted(byText))).toEqual([fields, fields]);
    expect(monitors.find(monitor => monitor.key === 'api-health')).toMatchObject({
      target: 'api.acme.test:8443',
      check: { method: 'POST', expectedStatus: [200] },
    });
    const locations = await exchange('GET', '/locations', token);
    expect(locations.body).toEqual({
      locations: [{ id: locationId, code: 'fra', name: 'Frankfurt', kind: LocationKinds.hosted, disabled: false }],
    });
  });

  it('needs a secret key with status:read to read and status:write to change', async () => {
    const { token: writer } = await keyOf(acme, [ApiScopes.statusWrite]);
    const { token: reader } = await keyOf(acme, [ApiScopes.statusRead]);
    const { token: runsReader } = await keyOf(acme, [ApiScopes.runsRead]);
    const { token: fromApp } = await keyOf(
      acme,
      [ApiScopes.statusRead, ApiScopes.statusWrite],
      ApiKeyKinds.publishable,
    );
    const { pageId } = await pageWithComponent(acme, 'acme');
    const incident = { pageId, title: 'Elevated errors', severity: 'major', body: 'Looking into it.' };
    const reads: Request[] = [
      ['GET', '/monitors'],
      ['GET', '/locations'],
      ['GET', '/pages'],
      ['GET', `/incidents?pageId=${pageId}`],
    ];
    const writes: Request[] = [
      ['PUT', '/monitors/by-key/api', httpMonitor()],
      ['POST', '/incidents', incident],
    ];

    expect(await statusOf('GET', '/monitors')).toBe(401);
    expect(await statusesOf(writes, reader)).toEqual(expected(writes, 403));
    expect(await statusesOf(writes, runsReader)).toEqual(expected(writes, 403));
    expect(await statusesOf(reads, writer)).toEqual(expected(reads, 403));
    expect(await statusesOf([...reads, ...writes], fromApp)).toEqual(expected([...reads, ...writes], 403));
    expect(await bodyOf('GET', '/monitors', fromApp)).toMatchObject({
      type: expect.stringContaining('wrong_key_kind'),
    });
    expect(await bodyOf('PUT', '/monitors/by-key/api', reader, httpMonitor())).toMatchObject({
      type: expect.stringContaining('insufficient_scope'),
    });
    expect(await monitorRows(acme)).toEqual([]);
    expect(await status.statusIncidents.list(acme, pageId, false)).toEqual([]);

    expect(await statusesOf(reads, reader)).toEqual(expected(reads, 200));
    expect(await statusOf('PUT', '/monitors/by-key/api', writer, httpMonitor())).toBe(201);
  });

  describe('tenant isolation', () => {
    it("answers 404 for another project's or workspace's monitor and leaves it alone", async () => {
      const mine = await readWrite(acme);
      const theirs = await upsert(await readWrite(blog), 'api-health', httpMonitor());
      const { id } = theirs.result.monitor;
      const before = await monitorRows(blog);
      const requests: Request[] = [
        ['GET', `/monitors/${id}`],
        ['POST', `/monitors/${id}/pause`],
        ['POST', `/monitors/${id}/resume`],
        ['POST', `/monitors/${id}/check`],
        ['DELETE', `/monitors/${id}`],
        ['GET', `/monitors/${randomUUID()}`],
        ['GET', '/monitors/not-a-uuid'],
      ];

      expect(await statusesOf(requests, mine)).toEqual(expected(requests, 404));
      expect(await bodyOf('GET', '/monitors', mine)).toEqual({ monitors: [] });

      // The same key in another project or workspace is that project's own monitor.
      expect(await statusOf('PUT', '/monitors/by-key/api-health', mine, httpMonitor())).toBe(201);
      const abroad = await readWrite(elsewhere);
      expect(await statusOf('PUT', '/monitors/by-key/api-health', abroad, httpMonitor())).toBe(201);
      expect(await monitorRows(blog)).toEqual(before);
    });

    it("answers 404 for another project's page, component, incident and maintenance", async () => {
      const { pageId, componentId } = await pageWithComponent(blog, 'blog');
      const incident = await status.statusIncidents.create(blog, userId, {
        pageId,
        title: 'Blog down',
        severity: 'major',
        status: IncidentStatuses.investigating,
        body: 'Looking into it.',
        components: [],
      });
      const window = await status.statusMaintenances.schedule(blog, userId, {
        pageId,
        title: 'Upgrade',
        body: '',
        scheduledStart: new Date(Date.now() + HOUR_MS),
        scheduledEnd: new Date(Date.now() + 2 * HOUR_MS),
        componentIds: [],
      });
      const start = new Date(Date.now() + HOUR_MS).toISOString();
      const end = new Date(Date.now() + 2 * HOUR_MS).toISOString();
      const requests: Request[] = [
        ['GET', `/pages/${pageId}/components`],
        ['PATCH', `/components/${componentId}`, { status: ComponentStatuses.majorOutage }],
        ['GET', `/incidents?pageId=${pageId}`],
        ['GET', `/incidents/${incident.id}`],
        ['POST', '/incidents', { pageId, title: 'x', severity: 'minor', body: 'x' }],
        ['POST', `/incidents/${incident.id}/updates`, { status: IncidentStatuses.resolved, body: 'Fixed.' }],
        ['PUT', `/incidents/${incident.id}/components`, { components: [] }],
        ['GET', `/maintenances?pageId=${pageId}`],
        ['POST', '/maintenances', { pageId, title: 'x', scheduledStart: start, scheduledEnd: end }],
        ['POST', `/maintenances/${window.id}/cancel`],
      ];

      const mine = await readWrite(acme);
      const foreign = await readWrite(elsewhere);
      expect(await statusesOf(requests, mine)).toEqual(expected(requests, 404));
      expect(await statusesOf(requests, foreign)).toEqual(expected(requests, 404));
      expect(await bodyOf('GET', '/pages', mine)).toEqual({ pages: [] });

      const after = await status.statusIncidents.get(blog, incident.id);
      expect(after.incident.status).toBe(IncidentStatuses.investigating);
      expect(after.updates).toHaveLength(1);
      const [stillScheduled] = await status.statusMaintenances.list(blog, pageId);
      expect(stillScheduled?.status).toBe(MaintenanceStatuses.scheduled);
      const { components } = await status.statusPages.getPage(blog, pageId);
      expect(components.map(component => component.status)).toEqual([ComponentStatuses.operational]);
    });
  });

  it('opens an incident, posts its updates, sets its components and lists it', async () => {
    const token = await readWrite(acme);
    const { pageId, componentId } = await pageWithComponent(acme, 'acme');
    const components = [{ componentId, impact: ComponentStatuses.partialOutage }];

    const opened = await exchange('POST', '/incidents', token, {
      pageId,
      title: 'Elevated API errors',
      severity: 'major',
      body: 'Looking into it.',
      components,
    });
    expect(opened.status).toBe(201);
    const { incident } = statusV1IncidentDetailSchema.parse(opened.body);
    expect(incident).toMatchObject({ status: IncidentStatuses.investigating, visibility: 'published' });
    expect(await bodyOf('GET', `/pages/${pageId}/components`, token)).toMatchObject({
      components: [{ id: componentId, displayedStatus: ComponentStatuses.partialOutage }],
    });

    const identified = await exchange('POST', `/incidents/${incident.id}/updates`, token, {
      status: IncidentStatuses.identified,
      body: 'A bad deploy.',
    });
    expect(identified).toMatchObject({
      status: 201,
      body: {
        incident: { status: IncidentStatuses.identified },
        update: { status: IncidentStatuses.identified, body: 'A bad deploy.' },
      },
    });
    const backwards = { status: IncidentStatuses.investigating, body: 'Hm.' };
    expect(await statusOf('POST', `/incidents/${incident.id}/updates`, token, backwards)).toBe(409);

    const cleared = await exchange('PUT', `/incidents/${incident.id}/components`, token, { components: [] });
    expect(statusV1IncidentDetailSchema.parse(cleared.body).components).toEqual([]);
    const detail = statusV1IncidentDetailSchema.parse(await bodyOf('GET', `/incidents/${incident.id}`, token));
    expect(detail.updates.map(update => update.status)).toEqual([
      IncidentStatuses.investigating,
      IncidentStatuses.identified,
    ]);
    expect(await bodyOf('GET', `/incidents?pageId=${pageId}&open=true`, token)).toMatchObject({
      incidents: [{ id: incident.id }],
    });
    expect(await statusOf('GET', '/incidents', token)).toBe(400);
  });

  it('schedules and cancels maintenance, and sets a component status', async () => {
    const token = await readWrite(acme);
    const { pageId, componentId } = await pageWithComponent(acme, 'acme');
    const start = new Date(Date.now() + HOUR_MS).toISOString();
    const end = new Date(Date.now() + 2 * HOUR_MS).toISOString();

    const inverted = { pageId, title: 'Upgrade', scheduledStart: end, scheduledEnd: start };
    expect(await statusOf('POST', '/maintenances', token, inverted)).toBe(400);
    const scheduled = await exchange('POST', '/maintenances', token, {
      pageId,
      title: 'Database upgrade',
      scheduledStart: start,
      scheduledEnd: end,
      componentIds: [componentId],
    });
    expect(scheduled.status).toBe(201);
    const window = statusV1MaintenanceSchema.parse(scheduled.body);
    expect(window).toMatchObject({
      status: MaintenanceStatuses.scheduled,
      scheduledStart: start,
      componentIds: [componentId],
      // An operator's window has no run.
      runId: null,
      overranAt: null,
      endNote: null,
    });

    expect(await bodyOf('POST', `/maintenances/${window.id}/cancel`, token)).toMatchObject({
      status: MaintenanceStatuses.canceled,
    });
    expect(await statusOf('POST', `/maintenances/${window.id}/cancel`, token)).toBe(409);
    expect(await bodyOf('GET', `/maintenances?pageId=${pageId}`, token)).toMatchObject({
      maintenances: [{ id: window.id, status: MaintenanceStatuses.canceled }],
    });

    const patched = await exchange('PATCH', `/components/${componentId}`, token, {
      status: ComponentStatuses.degraded,
    });
    expect(statusV1ComponentSchema.parse(patched.body)).toMatchObject({
      status: ComponentStatuses.degraded,
      displayedStatus: ComponentStatuses.degraded,
    });
    expect(await statusOf('PATCH', `/components/${componentId}`, token, { status: 'sideways' })).toBe(400);
  });

  it('pauses, resumes and deletes a monitor', async () => {
    const token = await readWrite(acme);
    const { result } = await upsert(token, 'api-health', httpMonitor());
    const { id } = result.monitor;

    expect(await bodyOf('POST', `/monitors/${id}/pause`, token)).toMatchObject({ state: 'paused' });
    expect(await bodyOf('POST', `/monitors/${id}/resume`, token)).toMatchObject({ state: 'pending' });
    const paused = await auditOf(AuditActions.statusMonitorPaused);
    expect(paused).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ principal: expect.stringMatching(/^apikey:/u) }) }),
    ]);

    expect(await statusOf('DELETE', `/monitors/${id}`, token)).toBe(204);
    expect(await statusOf('GET', `/monitors/${id}`, token)).toBe(404);
    expect(await monitorRows(acme)).toEqual([]);
  });
});
