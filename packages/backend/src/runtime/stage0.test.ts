// Stage0 end to end (relay design §11, #245): the real job runner over pglite sends the
// canary over (fake) HTTP to the real ingest route, the real fan-out queues it for the
// canary channel, a fake Discord takes the post and the delete, and the heartbeat is a
// recording fetch. Each way Mocco can break must stop the ping.
import { InboundEventTypes, InboundKinds } from '@mocco/common/inbound';
import { JobStatuses } from '@mocco/common/jobs';
import { DeliveryStatuses } from '@mocco/common/notification';
import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EventJobKinds } from '@backend/domain/events/EventBus';
import { createEventBus } from '@backend/domain/events/subscriptions';
import {
  createInboundHarness,
  ingestKeyOf,
  insertActor,
  signedDelivery,
  TEST_ORIGIN,
} from '@backend/domain/inbound/testing/harness';
import { PostgresJobQueue } from '@backend/domain/jobs/PostgresJobQueue';
import { JobRepo } from '@backend/domain/jobs/repos/job.repo';
import { NotificationJobKinds } from '@backend/domain/notification/constants';
import { DiscordApi } from '@backend/domain/notification/senders/discord';
import {
  createFakeDiscordFetch,
  emptyResponse,
  jsonResponse,
  type FakeReply,
} from '@backend/domain/notification/testing/fake-discord-fetch';
import { seedChannel, seedRule, seedWorkspace } from '@backend/domain/notification/testing/seed';
import { stage0FromEnv } from '@backend/domain/ops/config';
import { OpsJobKinds } from '@backend/domain/ops/jobs';
import { STAGE0_CANARY_INTERVAL_SECONDS, STAGE0_CANARY_REPO } from '@backend/domain/ops/Stage0CanaryService';
import { jobs, notificationDeliveries } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { createJobRunner } from '@backend/runtime/jobs';
import { createInboundRoutes } from '@backend/transport/ext/inbound';

const T0 = new Date('2026-10-06T00:00:00.000Z');
const HEARTBEAT_URL = 'https://ops.mocco.test/api/ext/v1/ping/mhb_test';
const POSTED = { id: '4242' };

/** How the canary's trip through Mocco is broken, if it is. */
const IngestModes = { up: 'up', notConfigured: 'notConfigured', unreachable: 'unreachable' } as const;
type IngestMode = (typeof IngestModes)[keyof typeof IngestModes];

interface WorldOptions {
  /** The fake Discord's replies, in order; `none` runs without a bot token. */
  discord?: FakeReply[] | 'none';
}

describe('stage0 canary and heartbeat (pglite)', () => {
  let t: TestDb;

  beforeEach(async () => {
    t = await createTestDb();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await t.close();
  });

  /** An ops workspace with a GitHub canary source routed to a private channel, and a
   * runner with stage0 on. */
  async function world(options: WorldOptions = {}) {
    const clock = { now: T0 };
    const now = () => clock.now;
    // The ingest route's bus, with every subscriber (its kicks are dropped: ticks run the jobs).
    const bus = createEventBus({
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
    const harness = createInboundHarness(t.db, { now, bus });
    const workspaceId = await seedWorkspace(t.db, 'Mocco ops');
    const actor = await insertActor(t.db);
    const { source } = await harness.sources.create(workspaceId, actor, {
      kind: InboundKinds.github,
      name: 'stage0 canary',
    });
    const channel = await seedChannel(t.db, workspaceId, 'stage0');
    await seedRule(t.db, channel, { eventType: InboundEventTypes['github.push'], sourceId: source.id });

    const state: { ingest: IngestMode } = { ingest: IngestModes.up };
    const up = new Hono().basePath('/api/ext').route('/', createInboundRoutes(harness.inbound));
    const notConfigured = new Hono().basePath('/api/ext').route('/', createInboundRoutes(undefined));
    const pings: string[] = [];
    const canaries: Request[] = [];
    // One fetch for stage0's two calls: the heartbeat, and the canary to the app's ingest route.
    const http: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.url === HEARTBEAT_URL) {
        pings.push(clock.now.toISOString());
        return new Response('OK');
      }
      canaries.push(request.clone());
      if (state.ingest === IngestModes.unreachable) {
        throw new TypeError('fetch failed');
      }
      return await (state.ingest === IngestModes.up ? up : notConfigured).fetch(request);
    };
    const fake = createFakeDiscordFetch(...(options.discord === 'none' ? [] : (options.discord ?? [])));
    const kicked: Promise<unknown>[] = [];
    const runner = createJobRunner(t.db, {
      now,
      random: () => 0,
      workerId: 'test',
      waitUntil: promise => {
        kicked.push(promise);
      },
      appOrigin: TEST_ORIGIN,
      discord: options.discord === 'none' ? undefined : new DiscordApi({ fetch: fake.fetch, botToken: 'bot', now }),
      storage: undefined,
      stage0: stage0FromEnv(
        { OPS_HEARTBEAT_URL: HEARTBEAT_URL, OPS_CANARY_SOURCE_ID: source.id },
        { fetch: http, box: harness.box },
      ),
    });

    /** Run ticks (and the jobs they kick) until nothing is left to do at this instant. */
    async function settle(): Promise<void> {
      for (let round = 0; round < 5; round += 1) {
        // eslint-disable-next-line no-await-in-loop -- each tick runs what the previous one queued
        await runner.tick({ budgetMs: 10_000, maxJobs: 100 });
        const running = [...kicked];
        kicked.length = 0;
        // eslint-disable-next-line no-await-in-loop -- the kicked jobs finish before the next tick
        await Promise.all(running);
      }
    }

    async function deliveries() {
      return await t.db.select().from(notificationDeliveries);
    }

    return {
      harness,
      clock,
      state,
      source,
      channel,
      pings,
      canaries,
      discord: fake.requests,
      settle,
      deliveries,
      advance: (seconds: number) => {
        clock.now = new Date(clock.now.getTime() + seconds * 1000);
      },
    };
  }

  /** Make every statement matching `when` on `table` fail inside the DB. */
  async function injectFailure(table: string, timing: 'INSERT' | 'UPDATE', when: string): Promise<void> {
    await t.db.execute(
      sql.raw(`CREATE OR REPLACE FUNCTION mocco_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'injected failure'; END $$`),
    );
    await t.db.execute(
      sql.raw(`CREATE TRIGGER mocco_test_fail BEFORE ${timing} ON ${table}
        FOR EACH ROW WHEN (${when}) EXECUTE FUNCTION mocco_test_fail()`),
    );
  }

  it('sends a signed canary, posts and deletes it in Discord, and pings the heartbeat', async () => {
    const w = await world({ discord: [jsonResponse(200, POSTED), emptyResponse(204)] });

    await w.settle();

    expect(w.canaries).toHaveLength(1);
    const [canary] = w.canaries;
    expect(canary?.method).toBe('POST');
    expect(canary?.url).toMatch(/^https:\/\/www\.mocco\.test\/api\/ext\/inbound\/[\w-]{43}$/u);
    expect(canary?.headers.get('x-hub-signature-256')).toMatch(/^sha256=[\da-f]{64}$/u);
    const [delivery] = await w.deliveries();
    expect(delivery).toMatchObject({ status: DeliveryStatuses.sent, externalMessageId: POSTED.id });
    expect(w.discord.map(request => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
      `POST /api/v10/channels/${w.channel.externalId}/messages`,
      `DELETE /api/v10/channels/${w.channel.externalId}/messages/${POSTED.id}`,
    ]);
    expect(w.discord[0]?.body).toContain(STAGE0_CANARY_REPO);
    expect(w.pings).toEqual([T0.toISOString()]);
  });

  it('pings once per canary, every five minutes, while Mocco works', async () => {
    const w = await world({
      discord: Array.from({ length: 3 }, () => [jsonResponse(200, POSTED), emptyResponse(204)]).flat(),
    });

    await w.settle();
    w.advance(STAGE0_CANARY_INTERVAL_SECONDS);
    await w.settle();
    w.advance(STAGE0_CANARY_INTERVAL_SECONDS);
    await w.settle();

    expect(w.pings).toHaveLength(3);
    expect(await w.deliveries()).toHaveLength(3);
  });

  it('still pings when only the delete fails: the post already proved the sender works', async () => {
    const w = await world({
      discord: [jsonResponse(200, POSTED), jsonResponse(404, { code: 10_008, message: 'Unknown Message' })],
    });

    await w.settle();

    expect(w.pings).toHaveLength(1);
  });

  it('neither deletes nor pings for a delivery from another source', async () => {
    // Discord answers every call 200 (a delete accepts any 2xx), whichever delivery goes first.
    const w = await world({ discord: Array.from({ length: 3 }, () => jsonResponse(200, POSTED)) });
    const actor = await insertActor(t.db);
    const { source: other, generatedSecret } = await w.harness.sources.create(w.channel.workspaceId, actor, {
      kind: InboundKinds.github,
      name: 'repo',
    });
    await seedRule(t.db, w.channel, { eventType: InboundEventTypes['github.push'], sourceId: other.id });
    await w.harness.inbound.ingest({
      ingestKey: ingestKeyOf(other.ingestUrl),
      ...signedDelivery(InboundKinds.github, generatedSecret ?? ''),
    });

    await w.settle();

    const delivered = await w.deliveries();
    expect(delivered.map(delivery => delivery.status)).toEqual([DeliveryStatuses.sent, DeliveryStatuses.sent]);
    expect(w.discord.filter(request => request.method === 'DELETE')).toHaveLength(1);
    expect(w.pings).toHaveLength(1);
  });

  describe('stops the heartbeat when Mocco breaks', () => {
    it('the ingest route answers an error', async () => {
      const w = await world({ discord: [jsonResponse(200, POSTED), emptyResponse(204)] });
      w.state.ingest = IngestModes.notConfigured;

      await w.settle();

      expect(w.canaries).toHaveLength(1);
      expect(await w.deliveries()).toEqual([]);
      expect(w.pings).toEqual([]);
      const [job] = await t.db.select().from(jobs).where(eq(jobs.kind, OpsJobKinds.canary));
      expect(job?.lastError).toContain('503');
    });

    it('the ingest route is unreachable', async () => {
      const w = await world({ discord: [jsonResponse(200, POSTED), emptyResponse(204)] });
      w.state.ingest = IngestModes.unreachable;

      await w.settle();

      expect(w.canaries).toHaveLength(1);
      expect(await w.deliveries()).toEqual([]);
      expect(w.pings).toEqual([]);
    });

    it('the DB refuses to record the delivery', async () => {
      const w = await world({ discord: [jsonResponse(200, POSTED), emptyResponse(204)] });
      await injectFailure('mocco_inbound_receipts', 'INSERT', 'true');

      await w.settle();

      expect(w.canaries).toHaveLength(1);
      expect(w.discord).toEqual([]);
      expect(w.pings).toEqual([]);
    });

    it('the DB cannot settle the delivery as sent, even after Discord posted it', async () => {
      const w = await world({ discord: [jsonResponse(200, POSTED), emptyResponse(204)] });
      await injectFailure('mocco_notification_deliveries', 'UPDATE', `NEW.status = '${DeliveryStatuses.sent}'`);

      await w.settle();

      expect(w.discord).toHaveLength(1);
      expect(w.pings).toEqual([]);
    });

    it('the queue cannot take the delivery job', async () => {
      const w = await world({ discord: [jsonResponse(200, POSTED), emptyResponse(204)] });
      await injectFailure('mocco_jobs', 'INSERT', `NEW.kind = '${NotificationJobKinds.deliver}'`);

      await w.settle();

      expect(w.canaries).toHaveLength(1);
      // The fan-out ran and failed: the delivery and its job are written together or not at all.
      const fanOut = await t.db.select().from(jobs).where(eq(jobs.kind, EventJobKinds.deliver));
      expect(fanOut.some(job => job.lastError?.includes(`params: ${NotificationJobKinds.deliver}`) === true)).toBe(
        true,
      );
      expect(await w.deliveries()).toEqual([]);
      expect(w.discord).toEqual([]);
      expect(w.pings).toEqual([]);
    });

    it('the queue cannot run the delivery job', async () => {
      const w = await world({ discord: [jsonResponse(200, POSTED), emptyResponse(204)] });
      await injectFailure(
        'mocco_jobs',
        'UPDATE',
        `NEW.kind = '${NotificationJobKinds.deliver}' AND NEW.status = '${JobStatuses.running}'`,
      );

      await w.settle();

      const [delivery] = await w.deliveries();
      expect(delivery?.status).toBe(DeliveryStatuses.queued);
      expect(w.discord).toEqual([]);
      expect(w.pings).toEqual([]);
    });

    it('Discord fails the post', async () => {
      const w = await world({ discord: [emptyResponse(500), emptyResponse(500), emptyResponse(500)] });

      await w.settle();

      const [delivery] = await w.deliveries();
      expect(delivery?.status).toBe(DeliveryStatuses.queued);
      expect(w.discord.length).toBeGreaterThan(0);
      expect(w.pings).toEqual([]);
    });

    it('Discord rejects the bot token', async () => {
      const w = await world({ discord: [jsonResponse(401, { code: 0, message: '401: Unauthorized' })] });

      await w.settle();

      const [delivery] = await w.deliveries();
      expect(delivery?.status).toBe(DeliveryStatuses.queued);
      expect(w.discord).toHaveLength(1);
      expect(w.pings).toEqual([]);
    });

    it('Discord is unreachable', async () => {
      const w = await world({ discord: [{ throws: new TypeError('fetch failed') }] });

      await w.settle();

      const [delivery] = await w.deliveries();
      expect(delivery?.status).toBe(DeliveryStatuses.queued);
      expect(w.discord).toHaveLength(1);
      expect(w.pings).toEqual([]);
    });

    it('the deployment has no Discord bot token', async () => {
      const w = await world({ discord: 'none' });

      await w.settle();

      const [delivery] = await w.deliveries();
      expect(delivery?.status).toBe(DeliveryStatuses.queued);
      expect(w.pings).toEqual([]);
    });

    it('and resumes the pings once Mocco recovers', async () => {
      const w = await world({ discord: [jsonResponse(200, POSTED), emptyResponse(204)] });
      w.state.ingest = IngestModes.notConfigured;
      await w.settle();
      expect(w.pings).toEqual([]);

      w.state.ingest = IngestModes.up;
      w.advance(STAGE0_CANARY_INTERVAL_SECONDS);
      await w.settle();

      expect(w.pings).toHaveLength(1);
      const canaryJobs = await t.db.select().from(jobs).where(eq(jobs.kind, OpsJobKinds.canary));
      expect(canaryJobs.some(job => job.status === JobStatuses.succeeded)).toBe(true);
    });
  });
});
