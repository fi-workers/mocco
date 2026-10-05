// The status API's OpenAPI description (#159) describes the API that is mounted: it lists exactly
// the routes status.ts and monitors.ts serve, it is served without a key, and real answers from
// the routes on pglite validate against the response schemas it gives.
import { randomUUID } from 'node:crypto';

import { ApiKeyKinds, ApiScopes } from '@mocco/common/apikey';
import { LocationKinds } from '@mocco/common/status';
import { Ajv2020 } from 'ajv/dist/2020.js';
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
import { createStatusApiRoutes, statusApiDepsOf } from '@backend/transport/ext/v1/status';
import { STATUS_OPERATIONS, statusOpenApiDocument } from '@backend/transport/ext/v1/status-openapi';

import type { V1Deps, V1Env } from '@backend/transport/ext/v1/middleware';

const BASE = '/api/ext/v1';
const byText = (a: string, b: string) => Number(a > b) - Number(a < b);

type Document = ReturnType<typeof statusOpenApiDocument>;
interface Described {
  responses: Record<string, { content?: Record<string, { schema: object }> }>;
  requestBody?: { content: Record<string, { schema: object }> };
}

const operationIn = (doc: Document, method: string, path: string) => {
  const operation = (doc.paths[path] as Record<string, Described> | undefined)?.[method];
  if (operation === undefined) {
    throw new Error(`${method} ${path} isn't described`);
  }
  return operation;
};

const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addFormat('uuid', /^[0-9a-f-]{36}$/u);
ajv.addFormat('date-time', value => !Number.isNaN(Date.parse(value)));
ajv.addFormat('uri', () => true);

/** Whether `value` fits the schema the document gives for that operation's answer (or request). */
function fits(schema: object, value: unknown): string | true {
  const validate = ajv.compile(schema);
  return validate(value) ? true : ajv.errorsText(validate.errors);
}

describe('status OpenAPI description', () => {
  it('lists exactly the status routes that are mounted', () => {
    const deps = { apiKeys: { authenticate: async () => ({ ok: false }) }, limiter: new MemoryRateLimiter() };
    // Hono lists a route once per handler (the key check, then the route's own).
    const mounted = new Set(
      createStatusApiRoutes(deps as unknown as V1Deps, {} as never).routes.map(
        route => `${route.method.toLowerCase()} ${route.path}`,
      ),
    );
    const described = STATUS_OPERATIONS.map(
      operation => `${operation.method} ${operation.path.replaceAll(/\{(\w+)\}/gu, ':$1')}`,
    );

    expect(described.toSorted(byText)).toEqual([...mounted, 'post /monitors/:monitorId/check'].toSorted(byText));
    expect(new Set(STATUS_OPERATIONS.map(operation => operation.operationId)).size).toBe(STATUS_OPERATIONS.length);
  });

  describe('against the routes (pglite)', () => {
    let t: TestDb;
    let app: Hono<V1Env>;
    let token: string;
    let locationId: string;

    beforeEach(async () => {
      t = await createTestDb();
      const audit = new AuditService({ audit: new AuditRepo(t.db) });
      const { projects } = createProjectDomain(t.db);
      const apiKeys = createApiKeyService(t.db, { projects, audit });
      const status = createStatusDomain(t.db, { audit });
      const userId = expectOne(
        await t.db
          .insert(users)
          .values({ id: randomUUID(), name: 'Ada', email: `${randomUUID()}@acme.test`, emailVerified: true })
          .returning(),
      ).id;
      const workspaceId = expectOne(
        await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning(),
      ).id;
      const project = await projects.create(workspaceId, { name: 'Acme', handle: 'acme' });
      ({ token } = await apiKeys.create(workspaceId, project.id, userId, {
        kind: ApiKeyKinds.secret,
        name: 'ci',
        scopes: [ApiScopes.statusRead, ApiScopes.statusWrite],
        expiresAt: null,
        flagEnvironmentId: null,
      }));
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

    it('is served without a key, with the base it was asked on as its server', async () => {
      const response = await app.request(`https://api.mocco.test${BASE}/status/openapi.json`);

      expect(response.status).toBe(200);
      const doc = (await response.json()) as Document;
      expect(doc).toMatchObject({ openapi: '3.1.0', servers: [{ url: `https://api.mocco.test${BASE}` }] });
    });

    it('gives schemas that real requests and answers fit', async () => {
      const doc = statusOpenApiDocument('https://api.mocco.test/v1');
      const body = {
        name: 'API health',
        spec: { kind: 'http', url: 'https://api.acme.test/health' },
        locationIds: [locationId],
      };
      const upsert = operationIn(doc, 'put', '/monitors/by-key/{key}');
      expect(fits(upsert.requestBody?.content['application/json']?.schema ?? {}, body)).toBe(true);
      expect(fits(upsert.requestBody?.content['application/json']?.schema ?? {}, { name: 1 })).not.toBe(true);

      const created = await app.request(`${BASE}/monitors/by-key/api-health`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const createdBody: unknown = await created.json();
      expect(fits(upsert.responses['201']?.content?.['application/json']?.schema ?? {}, createdBody)).toBe(true);

      const reads = await Promise.all(
        ['/monitors', '/locations', '/pages'].map(async path => {
          const answer = await app.request(`${BASE}${path}`, { headers: { authorization: `Bearer ${token}` } });
          const schema = operationIn(doc, 'get', path).responses['200']?.content?.['application/json']?.schema;
          const answered: unknown = await answer.json();
          return `${path}: ${String(fits(schema ?? {}, answered))}`;
        }),
      );
      expect(reads).toEqual(['/monitors: true', '/locations: true', '/pages: true']);

      const refused = await app.request(`${BASE}/monitors`);
      const problem = operationIn(doc, 'get', '/monitors').responses['401']?.content?.['application/problem+json'];
      expect(problem?.schema).toEqual({ $ref: '#/components/schemas/Problem' });
      expect(fits(doc.components.schemas.Problem, await refused.json())).toBe(true);
    });
  });
});
