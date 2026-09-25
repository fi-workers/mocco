// The stage0 canary end to end (docs/reference/ops-stage0.md): the job runner sends a
// signed canary over "HTTP" (the injected fetch is the real ingest route's `app.fetch`),
// the real InboundService records and publishes it, the fan-out and the Discord sender
// deliver it to a fake Discord, and the sent delivery deletes its message and pings the
// heartbeat. Every failure on that path must leave the heartbeat silent.
import { randomUUID } from 'node:crypto';

import { InboundKinds, InboundOutcomes } from '@mocco/common/inbound';
import { ChannelStatuses, DeliveryStatuses } from '@mocco/common/notification';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createEventBus } from '@backend/domain/events/subscriptions';
import { createInboundDomain } from '@backend/domain/inbound/instance';
import { InboundSourceRepo } from '@backend/domain/inbound/repos/inbound-source.repo';
import { createTestSecretBox, TEST_ORIGIN } from '@backend/domain/inbound/testing/harness';
import { PostgresJobQueue } from '@backend/domain/jobs/PostgresJobQueue';
import { JobRepo } from '@backend/domain/jobs/repos/job.repo';
import { DiscordApi } from '@backend/domain/notification/senders/discord';
import {
  createFakeDiscordFetch,
  emptyResponse,
  jsonResponse,
  type FakeReply,
} from '@backend/domain/notification/testing/fake-discord-fetch';
import { seedChannel, seedRule, seedWorkspace } from '@backend/domain/notification/testing/seed';
import { buildCanaryRequest } from '@backend/domain/ops/canary';
import { CanaryOutcomes, CanaryReasons, OpsJobKinds } from '@backend/domain/ops/constants';
import { OpsCanaryRepo } from '@backend/domain/ops/repos/ops-canary.repo';
import { Stage0Service, type Stage0Runtime } from '@backend/domain/ops/Stage0Service';
import { inboundReceipts, jobSchedules, notificationChannels, notificationDeliveries } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { createJobRunner } from '@backend/runtime/jobs';
import { createInboundRoutes } from '@backend/transport/ext/inbound';

import type { JobRunner } from '@backend/domain/jobs/JobRunner';
import type { Stage0Config } from '@backend/domain/ops/config';

const T0 = new Date('2026-09-25T10:00:00.000Z');
const SERVICE_DOMAIN = new URL(TEST_ORIGIN).host;
const HEARTBEAT_URL = 'https://hc-ping.test/ping/0f6c-check';
const MESSAGE_ID = '1234567890123456789';
const now = () => T0;

function urlOf(input: string | URL | Request): URL {
  if (typeof input === 'string') {
    return new URL(input);
  }
  return input instanceof URL ? input : new URL(input.url);
}

/** How the canary's own host answers: the real route, or a broken deployment. */
type IngestMode = 'route' | 'unreachable' | { status: number };

describe('stage0 canary and heartbeat (pglite)', () => {
  let t: TestDb;
  let heartbeats: string[];
  let ingestCalls: number;

  beforeEach(async () => {
    t = await createTestDb();
    heartbeats = [];
    ingestCalls = 0;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    // The invariant stage0 rests on: the heartbeat is pinged once per canary delivery
    // Discord accepted, and never otherwise.
    const sentCanaries = await t.db.select().from(notificationDeliveries);
    const sentCount = sentCanaries.filter(row => row.canary && row.status === DeliveryStatuses.sent).length;
    expect(heartbeats).toHaveLength(sentCount);
    vi.restoreAllMocks();
    await t.close();
  });

  async function setup(options: { discord?: FakeReply[]; ingest?: IngestMode; config?: Partial<Stage0Config> } = {}) {
    const box = createTestSecretBox();
    // The ingest lambda's bus: the real subscriber list; its kicks are dropped, so the
    // runner's tick delivers the event.
    const publisher = createEventBus({
      db: t.db,
      queue: new PostgresJobQueue({
        jobs: new JobRepo(t.db),
        now,
        runOne: async () => await Promise.resolve(null),
        waitUntil: () => {},
      }),
      now,
      appOrigin: TEST_ORIGIN,
    });
    const { sources, inbound } = createInboundDomain(t.db, { box, bus: publisher, now, baseOrigin: TEST_ORIGIN });
    const app = new Hono().basePath('/api/ext').route('/', createInboundRoutes(inbound));
    const mode = options.ingest ?? 'route';
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = urlOf(input);
      if (url.href === HEARTBEAT_URL) {
        heartbeats.push(url.href);
        return new Response('OK');
      }
      if (url.host !== SERVICE_DOMAIN) {
        throw new Error(`unexpected request to ${url.href}`);
      }
      ingestCalls += 1;
      if (mode === 'unreachable') {
        throw new TypeError('fetch failed');
      }
      if (mode !== 'route') {
        return new Response('down', { status: mode.status });
      }
      return await app.fetch(new Request(url, init));
    };

    const workspaceId = await seedWorkspace(t.db);
    const { source, generatedSecret } = await sources.create(workspaceId, {
      kind: InboundKinds.github,
      name: 'stage0 canary',
    });
    const channel = await seedChannel(t.db, workspaceId, 'mocco-canary');
    await seedRule(t.db, channel, { eventType: 'github.workflow_run.succeeded', sourceId: source.id });

    const discordFake = createFakeDiscordFetch(
      ...(options.discord ?? [jsonResponse(200, { id: MESSAGE_ID }), emptyResponse(204)]),
    );
    const discord = new DiscordApi({ fetch: discordFake.fetch, botToken: 'bot', now });
    const stage0: Stage0Runtime = {
      config: {
        canarySourceId: source.id,
        heartbeatUrl: HEARTBEAT_URL,
        serviceDomain: SERVICE_DOMAIN,
        ...options.config,
      },
      fetch: fetchImpl,
    };
    const kicked: Promise<unknown>[] = [];
    const runner = createJobRunner(t.db, {
      now,
      random: () => 0,
      workerId: 'test',
      waitUntil: promise => {
        kicked.push(promise);
      },
      appOrigin: TEST_ORIGIN,
      discord,
      box,
      stage0,
    });
    /** Tick until nothing new runs (the canary, its event, its delivery). */
    const drain = async (rounds = 3): Promise<void> => {
      await runner.tick({ budgetMs: 10_000, maxJobs: 50 });
      const pending = [...kicked];
      kicked.length = 0;
      await Promise.all(pending);
      if (rounds > 1) {
        await drain(rounds - 1);
      }
    };
    const standalone = new Stage0Service({
      stage0,
      sources: new InboundSourceRepo(t.db),
      box,
      canaries: new OpsCanaryRepo(t.db),
      discord,
    });
    return {
      app,
      channel,
      discordFake,
      drain,
      inbound,
      runner,
      secret: generatedSecret ?? '',
      source,
      sources,
      standalone,
      workspaceId,
    };
  }

  const canaries = async () => await new OpsCanaryRepo(t.db).findRecent(10);

  it('sends a signed canary the real route accepts, deletes its message and pings the heartbeat', async () => {
    const { channel, discordFake, drain } = await setup();

    await drain();

    const [receipt] = await t.db.select().from(inboundReceipts);
    expect(receipt).toMatchObject({
      externalId: 'stage0-2026-09-25T10:00Z',
      outcome: InboundOutcomes.published,
      eventType: 'github.workflow_run.succeeded',
    });
    const [delivery] = await t.db.select().from(notificationDeliveries);
    expect(delivery).toMatchObject({ status: DeliveryStatuses.sent, canary: true, externalMessageId: MESSAGE_ID });
    expect(discordFake.requests.map(request => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
      `POST /api/v10/channels/${channel.externalId}/messages`,
      `DELETE /api/v10/channels/${channel.externalId}/messages/${MESSAGE_ID}`,
    ]);
    expect(heartbeats).toEqual([HEARTBEAT_URL]);
    expect(await canaries()).toMatchObject([
      { canaryId: 'stage0-2026-09-25T10:00Z', ingestStatus: 202, error: null, deliveredAt: T0, heartbeatStatus: 200 },
    ]);
  });

  it('still pings when deleting the message fails (the send is what counts)', async () => {
    const { drain } = await setup({
      discord: [jsonResponse(200, { id: MESSAGE_ID }), jsonResponse(404, { code: 10_008, message: 'Unknown Message' })],
    });

    await drain();

    expect(heartbeats).toHaveLength(1);
  });

  describe('failures stop the heartbeat', () => {
    it.each([
      ['the ingest route is down (503)', { status: 503 }, CanaryReasons.ingestStatus(503)],
      ['the ingest function fails, e.g. the DB is down (500)', { status: 500 }, CanaryReasons.ingestStatus(500)],
      ['the ingest host does not answer', 'unreachable', CanaryReasons.ingestUnreachable('TypeError')],
    ] as const)('when %s', async (_label, ingest, reason) => {
      const { drain } = await setup({ ingest });

      await drain();

      expect(ingestCalls).toBe(1);
      expect(heartbeats).toEqual([]);
      expect(await t.db.select().from(notificationDeliveries)).toEqual([]);
      expect(await canaries()).toMatchObject([{ error: reason, deliveredAt: null, heartbeatAt: null }]);
    });

    it('while the queue does not run, and pings once it drains', async () => {
      const { drain, standalone } = await setup();

      // Accepted and published, but no tick runs the event and delivery jobs.
      expect(await standalone.sendCanary(T0)).toMatchObject({ outcome: CanaryOutcomes.accepted, status: 202 });
      const [receipt] = await t.db.select().from(inboundReceipts);
      expect(receipt?.outcome).toBe(InboundOutcomes.published);
      expect(await t.db.select().from(notificationDeliveries)).toEqual([]);
      expect(heartbeats).toEqual([]);

      await drain();

      expect(heartbeats).toHaveLength(1);
    });

    it('when the Discord sender is paused (the bot token is rejected)', async () => {
      const { drain } = await setup({ discord: [jsonResponse(401, { code: 0, message: '401: Unauthorized' })] });

      await drain();

      const [delivery] = await t.db.select().from(notificationDeliveries);
      expect(delivery).toMatchObject({ status: DeliveryStatuses.queued, canary: true });
      expect(heartbeats).toEqual([]);
    });

    it('when the canary channel is disabled (the delivery fails)', async () => {
      const { discordFake, drain } = await setup({
        discord: [jsonResponse(403, { code: 50_001, message: 'Missing Access' })],
      });

      await drain();

      const [delivery] = await t.db.select().from(notificationDeliveries);
      expect(delivery).toMatchObject({ status: DeliveryStatuses.failed, canary: true });
      const [channel] = await t.db.select().from(notificationChannels);
      expect(channel?.status).toBe(ChannelStatuses.disabled);
      expect(discordFake.requests).toHaveLength(1);
      expect(heartbeats).toEqual([]);
    });

    it('when the canary source is paused (nothing is sent)', async () => {
      const { drain, source, sources, workspaceId } = await setup();
      await sources.pause(workspaceId, source.id);

      await drain();

      expect(ingestCalls).toBe(0);
      expect(heartbeats).toEqual([]);
      expect(await canaries()).toMatchObject([{ error: CanaryReasons.sourcePaused, ingestStatus: null }]);
    });

    it('when the canary source does not exist', async () => {
      await setup();
      const missing = new Stage0Service({
        stage0: {
          config: { canarySourceId: randomUUID(), heartbeatUrl: HEARTBEAT_URL, serviceDomain: SERVICE_DOMAIN },
          fetch,
        },
        sources: new InboundSourceRepo(t.db),
        box: createTestSecretBox(),
        canaries: new OpsCanaryRepo(t.db),
        discord: undefined,
      });

      expect(await missing.sendCanary(T0)).toMatchObject({
        outcome: CanaryOutcomes.refused,
        reason: CanaryReasons.sourceNotFound,
      });
    });
  });

  describe('SSRF guard', () => {
    it.each([
      ['a SERVICE_DOMAIN that moves the host', 'www.mocco.test@evil.test', CanaryReasons.foreignHost],
      ['no SERVICE_DOMAIN', undefined, CanaryReasons.noServiceDomain],
    ])('never sends with %s', async (_label, serviceDomain, reason) => {
      const { drain } = await setup({ config: { serviceDomain } });

      await drain();

      expect(ingestCalls).toBe(0);
      expect(heartbeats).toEqual([]);
      expect(await canaries()).toMatchObject([{ error: reason }]);
    });

    it('does not follow a redirect from the ingest host', async () => {
      const { standalone } = await setup({ ingest: { status: 307 } });

      expect(await standalone.sendCanary(T0)).toMatchObject({
        outcome: CanaryOutcomes.failed,
        status: 307,
      });
      expect(ingestCalls).toBe(1);
    });
  });

  it('never treats another source’s run named like the canary as the canary', async () => {
    const { app, channel, drain, sources, workspaceId } = await setup({
      discord: [jsonResponse(200, { id: MESSAGE_ID })],
    });
    // Stop the scheduled canary: this test sends only the look-alike.
    await t.db.update(jobSchedules).set({ enabled: false });
    const other = await sources.create(workspaceId, { kind: InboundKinds.github, name: 'look-alike' });
    await seedRule(t.db, channel, { eventType: 'github.workflow_run.succeeded', sourceId: other.source.id });
    const lookAlike = buildCanaryRequest({
      canaryId: 'stage0-2026-09-25T10:00Z',
      secret: other.generatedSecret ?? '',
      appOrigin: TEST_ORIGIN,
    });

    const response = await app.request(new URL(other.source.ingestUrl).pathname, {
      method: 'POST',
      headers: lookAlike.headers,
      body: new Uint8Array(lookAlike.body),
    });
    await drain();

    expect(response.status).toBe(202);
    const [delivery] = await t.db.select().from(notificationDeliveries);
    expect(delivery).toMatchObject({ status: DeliveryStatuses.sent, canary: false });
    expect(heartbeats).toEqual([]);
  });

  describe('disabled without the env', () => {
    it('registers no canary schedule and sends nothing', async () => {
      const runner: JobRunner = createJobRunner(t.db, {
        now: () => T0,
        random: () => 0,
        workerId: 'test',
        waitUntil: () => {},
        appOrigin: TEST_ORIGIN,
        discord: undefined,
        box: createTestSecretBox(),
      });

      await runner.tick({ budgetMs: 10_000, maxJobs: 50 });

      const schedules = await t.db.select().from(jobSchedules);
      expect(schedules.map(schedule => schedule.kind)).not.toContain(OpsJobKinds.stage0Canary);
      expect(await canaries()).toEqual([]);
    });

    it('is a no-op service', async () => {
      const off = new Stage0Service({
        stage0: undefined,
        sources: new InboundSourceRepo(t.db),
        box: createTestSecretBox(),
        canaries: new OpsCanaryRepo(t.db),
        discord: undefined,
      });

      expect(await off.sendCanary(T0)).toEqual({ outcome: CanaryOutcomes.disabled });
    });
  });
});
