// The flags change stream (an OFREP event stream) against the real /v1 routes on pglite.
import { randomUUID } from 'node:crypto';

import { ApiKeyKinds, ApiScopes } from '@mocco/common/apikey';
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
import { users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { createV1Routes } from '@backend/transport/ext/v1/routes';

import type { V1Env } from '@backend/transport/ext/v1/middleware';

const BASE = 'https://www.mocco.test/api/ext/v1';

/* eslint-disable sonarjs/null-dereference -- the SSE parser below only handles decoded strings */
/** Read SSE events from a response until `count` arrive or `ms` pass. */
async function readEvents(response: Response, count: number, ms: number) {
  const { body } = response;
  if (body === null) {
    throw new Error('The stream has no body');
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const events: { id?: string; data?: string }[] = [];
  let buffer = '';
  const deadline = Date.now() + ms;
  while (events.length < count && Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop -- a stream is read in order
    const chunk = await Promise.race([
      reader.read(),
      new Promise<null>(resolve => {
        setTimeout(resolve, Math.max(0, deadline - Date.now()));
      }),
    ]);
    if (chunk === null || chunk.done) {
      break;
    }
    buffer += decoder.decode(chunk.value, { stream: true });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() ?? '';
    events.push(
      ...blocks
        .filter(block => block.includes('data:'))
        .map(block =>
          Object.fromEntries(
            block
              .split('\n')
              .filter(line => !line.startsWith(':'))
              .map(line => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1).trim()]),
          ),
        ),
    );
  }
  await reader.cancel();
  return events;
}
/* eslint-enable sonarjs/null-dereference */

describe('GET /v1/flags/stream (pglite)', () => {
  let t: TestDb;
  let app: Hono<V1Env>;
  let flags: FlagService;
  let tokens: StreamTokens;
  let workspaceId: string;
  let projectId: string;
  let environmentId: string;
  let userId: string;
  let key: string;

  const toggle = async (baseVersion: number, isOn: boolean) => {
    await flags.applyChangeset(workspaceId, projectId, userId, {
      environmentId,
      baseVersion,
      ops: [{ op: 'set_enabled', flagKey: 'checkout', enabled: isOn }],
      reason: null,
    });
  };

  beforeEach(async () => {
    t = await createTestDb();
    const audit = new AuditService({ audit: new AuditRepo(t.db) });
    const { projects } = createProjectDomain(t.db);
    const apiKeys = createApiKeyService(t.db, { projects, audit });
    flags = new FlagService({ db: t.db, audit });
    tokens = new StreamTokens('test-stream-key');
    app = new Hono<V1Env>().basePath('/api/ext').route(
      '/v1',
      createV1Routes({
        apiKeys,
        limiter: new MemoryRateLimiter(),
        flags: { flags, streamTokens: tokens, stream: { pollMs: 50, heartbeatMs: 10_000, maxConnectionMs: 5000 } },
      }),
    );
    workspaceId = expectOne(await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning()).id;
    userId = expectOne(
      await t.db
        .insert(users)
        .values({ email: `${randomUUID()}@acme.test` })
        .returning(),
    ).id;
    const project = await projects.create(workspaceId, { name: 'Acme', handle: 'acme' });
    projectId = project.id;
    const environment = await flags.createEnvironment(workspaceId, projectId, userId, {
      key: 'production',
      name: 'Production',
    });
    environmentId = environment.id;
    await flags.createBooleanFlag(workspaceId, projectId, userId, {
      key: 'checkout',
      description: null,
      lifecycle: 'temporary',
    });
    const created = await apiKeys.create(workspaceId, projectId, userId, {
      kind: ApiKeyKinds.secret,
      name: 'server',
      scopes: [ApiScopes.flagsRead],
      expiresAt: null,
      flagEnvironmentId: environmentId,
    });
    key = created.token;
  });
  afterEach(async () => {
    await t.close();
  });

  it('sends a refetchEvaluation event within 2 s of an applied change', async () => {
    const stream = await app.fetch(
      new Request(`${BASE}/flags/stream`, { headers: { authorization: `Bearer ${key}` } }),
    );
    const startedAt = Date.now();
    const events = readEvents(stream, 1, 2000);
    await toggle(1, true);
    const [event] = await events;
    const head = await flags.rulesetHead(workspaceId, environmentId);

    expect(stream.headers.get('content-type')).toMatch(/^text\/event-stream/u);
    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(event).toMatchObject({ id: '2', event: 'message' });
    expect(JSON.parse(event?.data ?? '{}')).toEqual({ type: 'refetchEvaluation', etag: head?.etag });
  });

  it('resumes from Last-Event-ID, and accepts a stream token in place of a key', async () => {
    await toggle(1, true);
    await toggle(2, false);
    const token = tokens.issue(workspaceId, environmentId);

    const resumed = await app.fetch(
      new Request(`${BASE}/flags/stream?token=${encodeURIComponent(token)}`, { headers: { 'last-event-id': '1' } }),
    );
    const [event] = await readEvents(resumed, 1, 1000);
    const forgedToken = encodeURIComponent(`${token}x`);
    const forged = await app.fetch(new Request(`${BASE}/flags/stream?token=${forgedToken}`));
    const anonymous = await app.fetch(new Request(`${BASE}/flags/stream`));

    expect(resumed.headers.get('access-control-allow-origin')).toBe('*');
    expect(event).toMatchObject({ id: '3' });
    expect([forged.status, anonymous.status]).toEqual([401, 401]);
  });
});
