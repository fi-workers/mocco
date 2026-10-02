// POST /v1/flags/telemetry (#144): SDKs' aggregated evaluation counts.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { ApiKeyKinds, ApiScopes } from '@mocco/common/apikey';
import { MoccoProvider } from '@mocco/openfeature-server';
import { OpenFeature } from '@openfeature/server-sdk';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApiKeyService } from '@backend/domain/apikey/instance';
import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { FlagService } from '@backend/domain/flags/FlagService';
import { FlagTelemetryService } from '@backend/domain/flags/FlagTelemetryService';
import { createProjectDomain } from '@backend/domain/project/instance';
import { MemoryRateLimiter } from '@backend/domain/ratelimit/MemoryRateLimiter';
import { expectOne } from '@backend/infra/db/rows';
import { flagEvalRollups, users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { TELEMETRY_RATE_LIMITS } from '@backend/transport/ext/v1/flags';
import { createV1Routes } from '@backend/transport/ext/v1/routes';

import type { V1Env } from '@backend/transport/ext/v1/middleware';
import type { ApiScope } from '@mocco/common/apikey';

const BASE = 'https://www.mocco.test/api/ext/v1';

const entry = (flag: string, count = 1, variant: string | null = 'on', windowStart = new Date().toISOString()) => ({
  flag,
  variant,
  count,
  windowStart,
});

const statusOf = async (response: Promise<Response>) => {
  const answer = await response;
  return answer.status;
};

describe('POST /v1/flags/telemetry (pglite)', () => {
  let t: TestDb;
  let app: Hono<V1Env>;
  let keys: { publishable: string; secret: string; otaOnly: string };

  const post = async (body: unknown, key: string) =>
    await app.fetch(
      new Request(`${BASE}/flags/telemetry`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
    );

  beforeEach(async () => {
    t = await createTestDb();
    const audit = new AuditService({ audit: new AuditRepo(t.db) });
    const { projects } = createProjectDomain(t.db);
    const apiKeys = createApiKeyService(t.db, { projects, audit });
    const flags = new FlagService({ db: t.db, audit });
    app = new Hono<V1Env>().basePath('/api/ext').route(
      '/v1',
      createV1Routes({
        apiKeys,
        // A fixed clock: a run that crosses a window boundary would reset the count.
        limiter: new MemoryRateLimiter(() => new Date('2026-10-02T10:00:30Z')),
        flags: { flags, telemetry: new FlagTelemetryService({ db: t.db }) },
      }),
    );
    const workspaceId = expectOne(
      await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning(),
    ).id;
    const userId = expectOne(
      await t.db
        .insert(users)
        .values({ email: `${randomUUID()}@acme.test` })
        .returning(),
    ).id;
    const project = await projects.create(workspaceId, { name: 'Acme', handle: 'acme' });
    const projectId = project.id;
    const environment = await flags.createEnvironment(workspaceId, projectId, userId, {
      key: 'production',
      name: 'Production',
    });
    const environmentId = environment.id;
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
    await flags.setClientVisible(workspaceId, projectId, userId, { flagKey: 'new-checkout', clientVisible: true });
    const create = async (
      kind: (typeof ApiKeyKinds)[keyof typeof ApiKeyKinds],
      scopes: ApiScope[] = [ApiScopes.flagsRead],
    ) => {
      const created = await apiKeys.create(workspaceId, projectId, userId, {
        kind,
        name: kind,
        scopes,
        expiresAt: null,
        flagEnvironmentId: scopes.includes(ApiScopes.flagsRead) ? environmentId : null,
      });
      return created.token;
    };
    keys = {
      publishable: await create(ApiKeyKinds.publishable),
      secret: await create(ApiKeyKinds.secret),
      otaOnly: await create(ApiKeyKinds.publishable, [ApiScopes.otaRead]),
    };
  });
  afterEach(async () => {
    await t.close();
  });

  it('adds counts to hourly buckets, ignoring unknown, hidden and out-of-window entries', async () => {
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const fromServer = await post(
      { evaluations: [entry('new-checkout', 5), entry('new-checkout', 2), entry('internal-ops', 1, null)] },
      keys.secret,
    );
    const fromBrowser = await post(
      {
        evaluations: [
          entry('new-checkout', 4, 'off'),
          entry('internal-ops'),
          entry('nope'),
          entry('new-checkout', 1, 'on', old),
        ],
      },
      keys.publishable,
    );

    expect([fromServer.status, fromBrowser.status]).toEqual([202, 202]);
    expect(await fromServer.json()).toEqual({ accepted: 3, ignored: 0 });
    // A publishable key reports only flags available to browsers and apps.
    expect(await fromBrowser.json()).toEqual({ accepted: 1, ignored: 3 });
    const rows = await t.db.select().from(flagEvalRollups);
    expect(new Set(rows.map(row => `${row.flagKey}/${row.variant}=${row.count}`))).toEqual(
      new Set(['internal-ops/=1', 'new-checkout/off=4', 'new-checkout/on=7']),
    );
    expect(rows.every(row => row.bucketHour.getUTCMinutes() === 0 && row.bucketHour.getUTCSeconds() === 0)).toBe(true);
  });

  it('rejects bad payloads with a 400 (zod) and keys without flags:read with a 403', async () => {
    const answers = await Promise.all([
      post('not json', keys.secret),
      post({ evaluations: [] }, keys.secret),
      post({ evaluations: [entry('Bad Key')] }, keys.secret),
      post({ evaluations: [entry('new-checkout', 0)] }, keys.secret),
      post({ evaluations: [entry('new-checkout', 1, 'on', 'yesterday')] }, keys.secret),
      post({ evaluations: Array.from({ length: 501 }, () => entry('new-checkout')) }, keys.secret),
      post({ evaluations: [entry('new-checkout')] }, keys.otaOnly),
    ]);
    expect(answers.map(answer => answer.status)).toEqual([400, 400, 400, 400, 400, 400, 403]);
    expect(await answers[3]?.json()).toMatchObject({ detail: expect.stringContaining('evaluations.0.count') });
    expect(await t.db.select().from(flagEvalRollups).where(eq(flagEvalRollups.flagKey, 'new-checkout'))).toEqual([]);
  });

  it('receives the counts the server provider sends', async () => {
    const provider = new MoccoProvider({
      secretKey: keys.secret,
      baseUrl: BASE,
      changeDetection: 'poll',
      fetch: async (input, init) => await app.fetch(new Request(input, init)),
    });
    const domain = `telemetry-${randomUUID()}`;
    await OpenFeature.setProviderAndWait(domain, provider);
    const client = OpenFeature.getClient(domain);
    await Promise.all(
      Array.from({ length: 4 }, async () => await client.getBooleanValue('new-checkout', true, { targetingKey: 'u1' })),
    );
    await OpenFeature.clearProviders();

    const rows = await t.db.select().from(flagEvalRollups);
    // A new flag is disabled: the provider serves the caller's default, with no variant.
    expect(rows.map(row => ({ flag: row.flagKey, variant: row.variant, count: row.count }))).toEqual([
      { flag: 'new-checkout', variant: '', count: 4 },
    ]);
  });

  it('is rate limited per key', async () => {
    const { limit } = TELEMETRY_RATE_LIMITS.secret;
    const statuses = await Array.from({ length: limit + 1 }).reduce<Promise<number[]>>(
      async previous => [
        ...(await previous),
        await statusOf(post({ evaluations: [entry('new-checkout')] }, keys.secret)),
      ],
      Promise.resolve([]),
    );
    expect(statuses.slice(0, limit).every(status => status === 202)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    // Another key isn't affected.
    expect(await statusOf(post({ evaluations: [entry('new-checkout')] }, keys.publishable))).toBe(202);
  });
});

describe('telemetry and governance', () => {
  it('no governance decision reads telemetry or stale findings', async () => {
    // Telemetry can be spoofed by anyone holding a key; it may only feed advisory hints.
    const governance = [
      '../../../domain/flags/FlagGovernanceService.ts',
      '../../../domain/flags/KillSwitchService.ts',
      '../../../domain/flags/RulesetPublisher.ts',
      '../../../domain/flags/FlagService.ts',
      '../../../domain/flags/apply-ops.ts',
      '../../../domain/governance/ApprovalService.ts',
    ];
    const sources = await Promise.all(
      governance.map(async path => await readFile(fileURLToPath(new URL(path, import.meta.url)), 'utf8')),
    );
    const readers = governance.filter((_, index) =>
      /flag-eval-rollup|flag-stale-finding|FlagTelemetryService|StaleFlagDetector|flagEvalRollups|flagStaleFindings/u.test(
        sources[index] ?? '',
      ),
    );
    expect(readers).toEqual([]);
  });
});
