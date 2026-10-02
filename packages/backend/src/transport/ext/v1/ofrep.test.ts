// OFREP for browsers and apps against the real /v1 routes on pglite: responses validate
// against the OFREP OpenAPI, never carry rules or segment lists, and the generic
// @openfeature/ofrep-web-provider works against them.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { ApiKeyKinds, ApiScopes } from '@mocco/common/apikey';
import { OFREPWebProvider } from '@openfeature/ofrep-web-provider';
import { OpenFeature } from '@openfeature/web-sdk';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApiKeyService } from '@backend/domain/apikey/instance';
import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { FlagService } from '@backend/domain/flags/FlagService';
import { StreamTokens } from '@backend/domain/flags/stream-token';
import { createProjectDomain } from '@backend/domain/project/instance';
import { MemoryRateLimiter } from '@backend/domain/ratelimit/MemoryRateLimiter';
import { expectOne } from '@backend/infra/db/rows';
import { projectApps, users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { createV1Routes } from '@backend/transport/ext/v1/routes';

import type { V1Env } from '@backend/transport/ext/v1/middleware';
import type { ValidateFunction } from 'ajv';

const BASE = 'https://www.mocco.test/api/ext/v1';
const SECRET_SEGMENT_KEY = 'customer-9f2c-internal';

async function ofrepValidator(name: string): Promise<ValidateFunction> {
  const doc = JSON.parse(
    await readFile(new URL('../../../domain/flags/testing/ofrep-openapi-schemas.json', import.meta.url), 'utf8'),
  ) as { $id: string };
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
  ajv.addSchema(doc);
  const validate = ajv.getSchema(`${doc.$id}#/components/schemas/${name}`);
  if (validate === undefined) {
    throw new Error(`No OFREP schema ${name}`);
  }
  return validate;
}

describe('OFREP /v1/ofrep/v1/evaluate (pglite)', () => {
  let t: TestDb;
  let app: Hono<V1Env>;
  let flags: FlagService;
  let publishable: string;
  let secret: string;
  let workspaceId: string;
  let projectId: string;
  let environmentId: string;

  const post = async (path: string, body: unknown, headers: Record<string, string> = {}, key = publishable) =>
    await app.fetch(
      new Request(`${BASE}/ofrep/v1/evaluate/${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      }),
    );

  beforeEach(async () => {
    t = await createTestDb();
    const audit = new AuditService({ audit: new AuditRepo(t.db) });
    const { projects } = createProjectDomain(t.db);
    const apiKeys = createApiKeyService(t.db, { projects, audit });
    flags = new FlagService({ db: t.db, audit });
    app = new Hono<V1Env>().basePath('/api/ext').route(
      '/v1',
      createV1Routes({
        apiKeys,
        limiter: new MemoryRateLimiter(),
        flags: { flags, streamTokens: new StreamTokens('test-stream-key') },
      }),
    );
    workspaceId = expectOne(await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning()).id;
    const userId = expectOne(
      await t.db
        .insert(users)
        .values({ email: `${randomUUID()}@acme.test` })
        .returning(),
    ).id;
    const project = await projects.create(workspaceId, { name: 'Acme', handle: 'acme' });
    projectId = project.id;
    await t.db
      .insert(projectApps)
      .values({ workspaceId, projectId, platform: 'web', name: 'Web', webOrigins: ['https://app.acme.test'] });
    const environment = await flags.createEnvironment(workspaceId, projectId, userId, {
      key: 'production',
      name: 'Production',
    });
    environmentId = environment.id;
    await flags.createBooleanFlag(workspaceId, projectId, userId, {
      key: 'new-checkout',
      description: null,
      lifecycle: 'temporary',
    });
    await flags.createBooleanFlag(workspaceId, projectId, userId, {
      key: 'internal-ops',
      description: null,
      lifecycle: 'temporary',
    });
    await flags.createFlag(workspaceId, projectId, userId, {
      key: 'checkout-copy',
      type: 'string',
      variants: { short: 'Pay', long: 'Pay securely' },
      defaultVariant: 'short',
      offVariant: 'short',
      description: null,
      lifecycle: 'temporary',
    });
    await flags.applyChangeset(workspaceId, projectId, userId, {
      environmentId,
      baseVersion: 3,
      ops: [
        {
          op: 'set_segment',
          segmentKey: 'vip',
          segment: { name: 'VIP', includedKeys: [SECRET_SEGMENT_KEY], excludedKeys: [], rules: [] },
        },
        { op: 'set_enabled', flagKey: 'new-checkout', enabled: true },
        {
          op: 'set_rules',
          flagKey: 'new-checkout',
          rules: [
            { clauses: [{ segment: 'vip', negate: false }], serve: { variant: 'on' } },
            { clauses: [{ attribute: 'plan', op: 'in', values: ['pro'] }], serve: { variant: 'on' } },
          ],
        },
        { op: 'set_default_variant', flagKey: 'new-checkout', variant: 'off' },
        { op: 'set_enabled', flagKey: 'checkout-copy', enabled: true },
        { op: 'set_enabled', flagKey: 'internal-ops', enabled: true },
      ],
      reason: null,
    });
    await flags.setClientVisible(workspaceId, projectId, userId, { flagKey: 'new-checkout', clientVisible: true });
    await flags.setClientVisible(workspaceId, projectId, userId, { flagKey: 'checkout-copy', clientVisible: true });
    const key = async (kind: (typeof ApiKeyKinds)[keyof typeof ApiKeyKinds]) => {
      const { token } = await apiKeys.create(workspaceId, projectId, userId, {
        kind,
        name: kind,
        scopes: [ApiScopes.flagsRead],
        expiresAt: null,
        flagEnvironmentId: environmentId,
      });
      return token;
    };
    publishable = await key(ApiKeyKinds.publishable);
    secret = await key(ApiKeyKinds.secret);
  });
  afterEach(async () => {
    await OpenFeature.clearProviders();
    await t.close();
  });

  it('answers a bulk evaluation that validates against the OFREP OpenAPI, with client-visible flags only', async () => {
    const validate = await ofrepValidator('bulkEvaluationSuccess');
    const response = await post(
      'flags',
      { context: { targetingKey: 'u1', plan: 'pro' } },
      { origin: 'https://app.acme.test' },
    );
    const body = (await response.json()) as { flags: { key: string }[]; eventStreams: { url: string }[] };

    expect(response.status).toBe(200);
    expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
    expect(body.flags).toEqual([
      { key: 'checkout-copy', reason: 'STATIC', variant: 'short', value: 'Pay' },
      { key: 'new-checkout', reason: 'TARGETING_MATCH', variant: 'on', value: true },
    ]);
    expect(response.headers.get('etag')).toMatch(/^"[\w-]+"$/u);
    expect(body.eventStreams).toEqual([
      { type: 'sse', url: expect.stringMatching(/\/api\/ext\/v1\/flags\/stream\?token=/u), inactivityDelaySec: 120 },
    ]);
    // The validator is meaningful: a reason outside OFREP's enum fails it.
    expect(validate({ flags: [{ key: 'x', reason: 'DEFAULT', value: true }] })).toBe(false);
  });

  it('never sends rules, segment lists or Mocco metadata to a client', async () => {
    const response = await post('flags', { context: { targetingKey: SECRET_SEGMENT_KEY } });
    const text = await response.text();

    expect(JSON.parse(text)).toMatchObject({
      flags: expect.arrayContaining([{ key: 'new-checkout', reason: 'TARGETING_MATCH', variant: 'on', value: true }]),
    });
    const leaks = [
      SECRET_SEGMENT_KEY.slice(0, 12),
      'vip',
      'targeting',
      'fractional',
      'mocco.killed',
      'mocco.offVariant',
      'internal-ops',
      'plan',
    ];
    expect(leaks.filter(leak => text.includes(leak))).toEqual([]);
  });

  it('answers 304 for the same context and ETag, and a new ETag for another context', async () => {
    const context = { context: { targetingKey: 'u1' } };
    const first = await post('flags', context);
    const etag = first.headers.get('etag') ?? '';

    const again = await post('flags', context, { 'if-none-match': etag });
    const other = await post('flags', { context: { targetingKey: 'u2', plan: 'pro' } }, { 'if-none-match': etag });

    expect(again.status).toBe(304);
    expect(other.status).toBe(200);
    expect(other.headers.get('etag')).not.toBe(etag);
  });

  it('evaluates one flag, hides flags a client may not see, and refuses a bad context', async () => {
    const success = await ofrepValidator('serverEvaluationSuccess');
    const notFound = await ofrepValidator('flagNotFound');

    const one = await post('flags/new-checkout', { context: { targetingKey: 'u1', plan: 'free' } });
    const hidden = await post('flags/internal-ops', { context: {} });
    const missing = await post('flags/nope', { context: {} });
    const bad = await post('flags/new-checkout', { context: 'pro' });
    const forServer = await post('flags/internal-ops', { context: {} }, {}, secret);

    const oneBody: unknown = await one.json();
    expect([one.status, hidden.status, missing.status, bad.status, forServer.status]).toEqual([
      200, 404, 404, 400, 200,
    ]);
    expect(oneBody).toEqual({ key: 'new-checkout', reason: 'STATIC', variant: 'off', value: false });
    expect(success(oneBody)).toBe(true);
    expect(notFound(await hidden.json())).toBe(true);
    expect(await bad.json()).toMatchObject({ key: 'new-checkout', errorCode: 'INVALID_CONTEXT' });
  });

  it('works with the generic OpenFeature OFREP web provider', async () => {
    const provider = new OFREPWebProvider({
      baseUrl: BASE,
      headers: [['Authorization', `Bearer ${publishable}`]],
      fetchImplementation: async (input, init) => await app.fetch(new Request(input, init)),
      cacheMode: 'disabled',
      changeDetection: 'none',
      disableVisibilityRefresh: true,
    });
    await OpenFeature.setContext({ targetingKey: 'u1', plan: 'pro' });
    await OpenFeature.setProviderAndWait(provider);
    const client = OpenFeature.getClient();

    expect(client.getBooleanDetails('new-checkout', false)).toMatchObject({
      value: true,
      variant: 'on',
      reason: 'TARGETING_MATCH',
    });
    expect(client.getStringValue('checkout-copy', 'fallback')).toBe('Pay');
    expect(client.getBooleanDetails('internal-ops', false)).toMatchObject({
      value: false,
      errorCode: 'FLAG_NOT_FOUND',
    });
  });
});
