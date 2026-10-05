// /v1/ping/:token over HTTP (#153): GET and POST pings with no key, `/start`, `/fail` and an exit
// code; a wrong or unknown token gets exactly the 404 of a missing route; limits per token and per
// client address. What a ping does to the monitor is pinned in domain/status/heartbeat.test.ts.
import { randomUUID } from 'node:crypto';

import { MonitorKinds, MonitorStates, monitorInputSchema } from '@mocco/common/status';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApiKeyService } from '@backend/domain/apikey/instance';
import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { createProjectDomain } from '@backend/domain/project/instance';
import { MemoryRateLimiter } from '@backend/domain/ratelimit/MemoryRateLimiter';
import { createStatusDomain } from '@backend/domain/status/compose';
import { expectOne } from '@backend/infra/db/rows';
import { statusMonitors, users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { PING_ADDRESS_RATE_LIMIT, PING_TOKEN_RATE_LIMIT } from '@backend/transport/ext/v1/heartbeat-ping';
import { createV1Routes } from '@backend/transport/ext/v1/routes';

const T0 = new Date('2026-10-05T09:00:00.000Z');
const BASE = 'https://www.mocco.test/api/ext/v1';

/** What a client can tell from a response: its status, content type and body. */
async function shapeOf(response: Response) {
  return { status: response.status, type: response.headers.get('content-type'), body: await response.text() };
}

/** `count` calls of `run`, one after the other. */
async function inSequence<T>(count: number, run: () => Promise<T>): Promise<T[]> {
  return await Array.from({ length: count }).reduce<Promise<T[]>>(
    async (previous: Promise<T[]>) => [...(await previous), await run()],
    Promise.resolve([]),
  );
}

describe('/v1/ping (pglite)', () => {
  let t: TestDb;
  let app: Hono;
  let clock: Date;
  let token: string;
  let monitorId: string;

  const ping = async (path: string, init: RequestInit = {}) => await app.request(`${BASE}/ping/${path}`, init);
  const statusOf = async (path: string, init: RequestInit = {}) => {
    const response = await ping(path, init);
    return response.status;
  };
  const monitor = async () =>
    expectOne(await t.db.select().from(statusMonitors).where(eq(statusMonitors.id, monitorId)));
  const tick = () => {
    clock = new Date(clock.getTime() + 1000);
  };

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
    const created = await status.statusMonitors.create(
      { workspaceId, projectId: project.id },
      actor,
      monitorInputSchema.parse({ name: 'Backup', spec: { kind: MonitorKinds.heartbeat } }),
    );
    token = created.heartbeatToken ?? '';
    monitorId = created.id;
    // The same mounting as the ext app: a missing route gets the app's own 404.
    app = new Hono().basePath('/api/ext').route(
      '/v1',
      createV1Routes({
        apiKeys: createApiKeyService(t.db, { projects, audit }),
        limiter: new MemoryRateLimiter(() => clock),
        heartbeats: { heartbeats: status.statusHeartbeats },
      }),
    );
  });
  afterEach(async () => {
    await t.close();
  });

  it('takes GET and POST pings without a key', async () => {
    const get = await ping(token);
    expect(get.status).toBe(200);
    expect(await get.text()).toBe('OK');
    expect(await monitor()).toMatchObject({ state: MonitorStates.up });

    tick();
    expect(await statusOf(`${token}/fail`, { method: 'POST', body: 'disk full' })).toBe(200);
    expect(await monitor()).toMatchObject({ state: MonitorStates.down });
  });

  it('reads /start, an exit code of 0 and a non-zero exit code', async () => {
    expect(await statusOf(`${token}/start`)).toBe(200);
    expect(await monitor()).toMatchObject({ state: MonitorStates.pending, lastStartAt: clock });

    tick();
    expect(await statusOf(`${token}/0`, { method: 'POST' })).toBe(200);
    expect(await monitor()).toMatchObject({ state: MonitorStates.up, lastDurationMs: 1000 });

    tick();
    expect(await statusOf(`${token}/137`)).toBe(200);
    expect(await monitor()).toMatchObject({ state: MonitorStates.down });

    // Not an exit code a process has.
    expect(await statusOf(`${token}/256`)).toBe(404);
  });

  it('answers a wrong or unknown token exactly like a missing route', async () => {
    const expected = await shapeOf(await app.request(`${BASE}/no-such-route`));
    expect(expected.status).toBe(404);
    const other = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    const answers = await Promise.all(
      [`mhb_${'x'.repeat(43)}`, `mhb_${'x'.repeat(43)}/fail`, 'not-a-token', `${other}/start`, `${token}/nope`].map(
        async path => await shapeOf(await ping(path, { method: 'POST' })),
      ),
    );
    expect(answers).toEqual(answers.map(() => expected));
    expect(await monitor()).toMatchObject({ lastPingAt: null });
  });

  it('limits pings per token, before the token is looked up', async () => {
    const burst = async (path: string) =>
      await inSequence(PING_TOKEN_RATE_LIMIT.limit + 1, async () => await statusOf(path));
    expect(await burst(token)).toEqual([...Array.from({ length: PING_TOKEN_RATE_LIMIT.limit }, () => 200), 429]);
    // An unknown token has its own bucket: 404s, then the same 429, never a hint.
    expect(await burst(`mhb_${'y'.repeat(43)}`)).toEqual([
      ...Array.from({ length: PING_TOKEN_RATE_LIMIT.limit }, () => 404),
      429,
    ]);

    // The next window takes pings again.
    clock = new Date(clock.getTime() + PING_TOKEN_RATE_LIMIT.windowSeconds * 1000);
    expect(await statusOf(token)).toBe(200);
  });

  it('limits pings per client address across tokens', async () => {
    const headers = { 'x-forwarded-for': '203.0.113.7' };
    const statuses = await Promise.all(
      Array.from({ length: PING_ADDRESS_RATE_LIMIT.limit }, async () => await statusOf('not-a-token', { headers })),
    );
    expect(new Set(statuses)).toEqual(new Set([404]));
    expect(await statusOf(token, { headers })).toBe(429);
    // Another address is unaffected.
    expect(await statusOf(token, { headers: { 'x-forwarded-for': '198.51.100.9' } })).toBe(200);
  });
});
