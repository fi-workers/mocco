import { InboundKinds } from '@mocco/common/inbound';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InboundSourceRepo } from '@backend/domain/inbound/repos/inbound-source.repo';
import { parse, verify } from '@backend/domain/inbound/sources/github';
import { ParsedInboundKinds } from '@backend/domain/inbound/sources/shared';
import { createInboundHarness, insertActor, insertWorkspace } from '@backend/domain/inbound/testing/harness';
import { CanaryRejectedError, CanarySourceError } from '@backend/domain/ops/errors';
import { STAGE0_CANARY_BRANCH, STAGE0_CANARY_REPO, Stage0CanaryService } from '@backend/domain/ops/Stage0CanaryService';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

const T0 = new Date('2026-10-06T00:00:00.000Z');
const ORIGIN = 'https://www.mocco.test';

describe('Stage0CanaryService (pglite)', () => {
  let t: TestDb;

  beforeEach(async () => {
    t = await createTestDb();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await t.close();
  });

  async function setup(kind: (typeof InboundKinds)[keyof typeof InboundKinds] = InboundKinds.github) {
    const harness = createInboundHarness(t.db, { now: () => T0 });
    const workspaceId = await insertWorkspace(t.db, 'ops');
    const actor = await insertActor(t.db);
    const created = await harness.sources.create(workspaceId, actor, {
      kind,
      name: 'stage0 canary',
      ...(kind !== InboundKinds.github && { secret: 'vendor-shown-secret' }),
    });
    const requests: Request[] = [];
    const replies: (Response | Error)[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      requests.push(new Request(input, init));
      const reply = replies.shift() ?? new Response('accepted', { status: 202 });
      if (reply instanceof Error) {
        throw reply;
      }
      return await Promise.resolve(reply);
    };
    const service = (sourceId: string) =>
      new Stage0CanaryService({
        sources: new InboundSourceRepo(t.db),
        box: harness.box,
        fetch,
        appOrigin: ORIGIN,
        sourceId,
        now: () => T0,
      });
    return { harness, workspaceId, actor, ...created, requests, replies, service };
  }

  it('signs a GitHub push to the source ingest URL that the GitHub adapter verifies and maps', async () => {
    const { source, generatedSecret, service } = await setup();

    const request = await service(source.id).build('stage0-job-1');

    expect(request.url).toBe(source.ingestUrl);
    expect(request.url.startsWith(`${ORIGIN}/api/ext/inbound/`)).toBe(true);
    const headers = new Headers(request.headers);
    expect(headers.get('x-github-delivery')).toBe('stage0-job-1');
    const body = new TextEncoder().encode(request.body);
    expect(verify(body, headers, generatedSecret ?? '')).toBe(true);
    expect(parse(request.body, headers)).toMatchObject({
      kind: ParsedInboundKinds.event,
      facts: { repo: STAGE0_CANARY_REPO, branch: STAGE0_CANARY_BRANCH, hasCommits: true },
    });
  });

  it('posts the canary and resolves on a 202', async () => {
    const { source, requests, service } = await setup();

    await service(source.id).send('stage0-job-1');

    expect(requests.map(request => `${request.method} ${request.url}`)).toEqual([`POST ${source.ingestUrl}`]);
  });

  it('throws when the ingest route answers anything but 202, or nothing', async () => {
    const { source, replies, service } = await setup();
    replies.push(new Response('invalid signature', { status: 401 }), new TypeError('fetch failed'));

    await expect(service(source.id).send('a')).rejects.toThrow(CanaryRejectedError);
    await expect(service(source.id).send('b')).rejects.toThrow(CanaryRejectedError);
  });

  it('refuses a missing, non-GitHub or paused source without sending', async () => {
    const github = await setup();
    const sentry = await setup(InboundKinds.sentry);
    await github.harness.sources.pause(github.workspaceId, github.actor, github.source.id);

    await expect(github.service('00000000-0000-4000-8000-000000000000').send('a')).rejects.toThrow(CanarySourceError);
    await expect(sentry.service(sentry.source.id).send('b')).rejects.toThrow(/GitHub source/u);
    await expect(github.service(github.source.id).send('c')).rejects.toThrow(/paused/u);
    expect([...github.requests, ...sentry.requests]).toEqual([]);
  });
});
