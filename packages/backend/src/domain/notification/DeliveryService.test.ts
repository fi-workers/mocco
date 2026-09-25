import { randomUUID } from 'node:crypto';

import { JobStatuses } from '@mocco/common/jobs';
import { ChannelStatuses, DeliveryStatuses, Severities } from '@mocco/common/notification';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DomainEventRepo } from '@backend/domain/events/repos/domain-event.repo';
import { JobRepo } from '@backend/domain/jobs/repos/job.repo';
import { RetryAt } from '@backend/domain/jobs/retry-at';
import { DeliveryReasons, NotificationJobKinds } from '@backend/domain/notification/constants';
import { DeliveryService, deliveryNonce } from '@backend/domain/notification/DeliveryService';
import { TransientDeliveryError } from '@backend/domain/notification/errors';
import { ChannelRepo, type ChannelRow } from '@backend/domain/notification/repos/channel.repo';
import { DeliveryRepo, type DeliveryRow } from '@backend/domain/notification/repos/delivery.repo';
import { DiscordRateLimitRepo } from '@backend/domain/notification/repos/discord-rate-limit.repo';
import { DiscordApi } from '@backend/domain/notification/senders/discord';
import { DiscordJsonErrorCodes } from '@backend/domain/notification/senders/discord-constants';
import {
  createFakeDiscordFetch,
  jsonResponse,
  type FakeReply,
  type RecordedRequest,
} from '@backend/domain/notification/testing/fake-discord-fetch';
import { seedChannel, seedWorkspace } from '@backend/domain/notification/testing/seed';
import { discordRateLimits, jobs, notificationChannels, notificationDeliveries } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type { NeutralMessage } from '@mocco/common/notification';

const NOW = new Date('2026-09-25T12:00:00.000Z');
const SECOND = 1000;
const HOUR = 60 * 60 * SECOND;
const later = (ms: number) => new Date(NOW.getTime() + ms);

const message: NeutralMessage = {
  title: 'Approval needed: deploy · production',
  severity: Severities.warning,
  fields: [],
  footer: 'Mocco',
};

/** The run asked the job to retry at exactly `at` — by default as a free capacity wait. */
async function expectRetryAt(run: Promise<unknown>, at: Date, isFreeWait = true): Promise<void> {
  await expect(run).rejects.toBeInstanceOf(RetryAt);
  await expect(run).rejects.toMatchObject({ at, isFreeWait });
}

const sentTo = (requests: RecordedRequest[]) => requests.map(request => new URL(request.url).pathname);

describe('DeliveryService (pglite, fake Discord)', () => {
  let t: TestDb;
  let deliveries: DeliveryRepo;
  let channels: ChannelRepo;
  let rateLimits: DiscordRateLimitRepo;
  let workspaceId: string;
  let channel: ChannelRow;

  beforeEach(async () => {
    t = await createTestDb();
    deliveries = new DeliveryRepo(t.db);
    channels = new ChannelRepo(t.db);
    rateLimits = new DiscordRateLimitRepo(t.db);
    workspaceId = await seedWorkspace(t.db);
    channel = await seedChannel(t.db, workspaceId);
  });

  afterEach(async () => {
    await t.close();
  });

  /** A service whose Discord answers with `script`, in order; any extra call throws. */
  const serviceWith = (random: () => number, ...script: FakeReply[]) => {
    const fake = createFakeDiscordFetch(...script);
    const discord = new DiscordApi({ fetch: fake.fetch, botToken: 'bot-token-secret', now: () => NOW, timeoutMs: 20 });
    return {
      delivery: new DeliveryService({ deliveries, channels, rateLimits, discord, random }),
      requests: fake.requests,
    };
  };
  const service = (...script: FakeReply[]) => serviceWith(() => 0, ...script);

  const seedDelivery = async (target: ChannelRow = channel): Promise<DeliveryRow> => {
    const { event } = await new DomainEventRepo(t.db).insert({
      workspaceId: target.workspaceId,
      projectId: null,
      type: 'gate.pending',
      subjectType: 'run_gate',
      subjectId: randomUUID(),
      payload: {},
      dedupeKey: null,
      occurredAt: NOW,
    });
    const created = await deliveries.createQueued(
      { workspaceId: target.workspaceId, channelId: target.id, eventId: event.id, ruleId: null, message },
      async () => await Promise.resolve(null),
    );
    if (created === undefined) {
      throw new Error('delivery not created');
    }
    // Queued "now" on the test clock (the column defaults to the wall clock).
    await t.db
      .update(notificationDeliveries)
      .set({ createdAt: NOW })
      .where(eq(notificationDeliveries.id, created.delivery.id));
    return { ...created.delivery, createdAt: NOW };
  };

  const reload = async (id: string) => {
    const row = await deliveries.findById(id);
    if (row === undefined) {
      throw new Error(`delivery ${id} is gone`);
    }
    return row;
  };
  const reloadChannel = async () => await channels.findById(workspaceId, channel.id);
  const bucket = async (key: string) => {
    const [row] = await t.db.select().from(discordRateLimits).where(eq(discordRateLimits.bucket, key));
    return row?.blockedUntil;
  };

  const seedSent = async (count: number, sentAt: (index: number) => Date) => {
    const rows = await Promise.all(Array.from({ length: count }, async () => await seedDelivery()));
    await rows.reduce(async (previous, row, index) => {
      await previous;
      await t.db
        .update(notificationDeliveries)
        .set({ status: DeliveryStatuses.sent, sentAt: sentAt(index) })
        .where(eq(notificationDeliveries.id, row.id));
    }, Promise.resolve());
  };

  const first = { isFinalAttempt: false, now: NOW };
  const last = { isFinalAttempt: true, now: NOW };

  describe('result mapping', () => {
    it('sent: stores the message id and the exhausted bucket', async () => {
      const { delivery, requests } = service(
        jsonResponse(200, { id: '999' }, { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset-After': '2' }),
      );
      const row = await seedDelivery();

      await delivery.deliver(row.id, first);

      expect(sentTo(requests)).toEqual([`/api/v10/channels/${channel.externalId}/messages`]);
      expect(await reload(row.id)).toMatchObject({
        status: DeliveryStatuses.sent,
        externalMessageId: '999',
        sentAt: NOW,
        attempts: 1,
        error: null,
        nextAttemptAt: null,
      });
      expect(await bucket(`channel:${channel.externalId}`)).toEqual(later(2 * SECOND));
    });

    it('rate limited on the channel: blocks the channel bucket and retries at retry_after', async () => {
      const { delivery } = service(
        jsonResponse(429, { message: 'rate limited', retry_after: 3, global: false }, { 'X-RateLimit-Scope': 'user' }),
      );
      const row = await seedDelivery();

      await expectRetryAt(delivery.deliver(row.id, first), later(3 * SECOND), false);

      expect(await reload(row.id)).toMatchObject({
        status: DeliveryStatuses.queued,
        responseCode: 429,
        error: DeliveryReasons.rateLimited,
        nextAttemptAt: later(3 * SECOND),
      });
      expect(await bucket(`channel:${channel.externalId}`)).toEqual(later(3 * SECOND));
      expect(await bucket('global')).toBeUndefined();
    });

    it('rate limited globally: blocks the global bucket', async () => {
      const { delivery } = service(
        jsonResponse(429, { message: 'global', retry_after: 5, global: true }, { 'X-RateLimit-Scope': 'global' }),
      );
      const row = await seedDelivery();

      await expectRetryAt(delivery.deliver(row.id, first), later(5 * SECOND), false);

      expect(await bucket('global')).toEqual(later(5 * SECOND));
    });

    it('permanent with disableChannel: disables the channel and fails the delivery without retry', async () => {
      const { delivery } = service(
        jsonResponse(403, { message: 'Missing Access', code: DiscordJsonErrorCodes.MissingAccess }),
      );
      const row = await seedDelivery();

      await delivery.deliver(row.id, first);

      const failed = await reload(row.id);
      expect(failed.status).toBe(DeliveryStatuses.failed);
      expect(failed.error).toBe('Discord 403 (code 50001): Missing Access');
      expect(await reloadChannel()).toMatchObject({
        status: ChannelStatuses.disabled,
        disabledReason: 'Discord 403 (code 50001): Missing Access',
      });

      // The next delivery to that channel fails without calling Discord (the fake has no reply left).
      const next = await seedDelivery();
      await service().delivery.deliver(next.id, first);
      expect(await reload(next.id)).toMatchObject({
        status: DeliveryStatuses.failed,
        error: 'channel disabled: Discord 403 (code 50001): Missing Access',
        attempts: 0,
      });
    });

    it('permanent with disableSender: pauses every send for an hour and keeps the delivery queued', async () => {
      const { delivery } = service(jsonResponse(401, { message: '401: Unauthorized', code: 0 }));
      const row = await seedDelivery();

      await expectRetryAt(delivery.deliver(row.id, first), later(HOUR));

      expect(await bucket('global')).toEqual(later(HOUR));
      const queued = await reload(row.id);
      expect(queued.status).toBe(DeliveryStatuses.queued);
      expect(queued.error).toContain(DeliveryReasons.senderPaused);
      expect(queued.error).not.toContain('bot-token-secret');
      expect(await reloadChannel()).toMatchObject({ status: ChannelStatuses.active });
    });

    it('other permanent failures fail the delivery and leave the channel alone', async () => {
      const { delivery } = service(
        jsonResponse(400, { message: 'Invalid Form Body', code: DiscordJsonErrorCodes.InvalidFormBody }),
      );
      const row = await seedDelivery();

      await delivery.deliver(row.id, first);

      expect(await reload(row.id)).toMatchObject({
        status: DeliveryStatuses.failed,
        error: 'Discord 400 (code 50035): Invalid Form Body',
      });
      expect(await reloadChannel()).toMatchObject({ status: ChannelStatuses.active });
    });

    it('transient: throws for the job backoff, and fails the delivery on the last attempt', async () => {
      const { delivery } = service(jsonResponse(502, {}), jsonResponse(503, {}));
      const row = await seedDelivery();

      await expect(delivery.deliver(row.id, first)).rejects.toBeInstanceOf(TransientDeliveryError);
      expect(await reload(row.id)).toMatchObject({
        status: DeliveryStatuses.queued,
        responseCode: 502,
        error: 'Discord 502',
      });

      await expect(delivery.deliver(row.id, last)).rejects.toBeInstanceOf(TransientDeliveryError);
      expect(await reload(row.id)).toMatchObject({
        status: DeliveryStatuses.failed,
        responseCode: 503,
        error: 'Discord 503',
        attempts: 2,
      });
    });

    it('a network error is transient too', async () => {
      const { delivery } = service({ throws: new TypeError('fetch failed') });
      const row = await seedDelivery();

      await expect(delivery.deliver(row.id, first)).rejects.toBeInstanceOf(TransientDeliveryError);
      expect(await reload(row.id)).toMatchObject({ error: 'network error reaching Discord (TypeError)' });
    });
  });

  describe('rate limit buckets', () => {
    it('waits for a blocked channel bucket without calling Discord', async () => {
      await rateLimits.block(`channel:${channel.externalId}`, later(4 * SECOND));
      const row = await seedDelivery();

      await expectRetryAt(service().delivery.deliver(row.id, first), later(4 * SECOND));

      expect(await reload(row.id)).toMatchObject({ status: DeliveryStatuses.queued, attempts: 0 });
    });

    it('waits for a blocked global bucket, whichever channel', async () => {
      await rateLimits.block('global', later(HOUR));
      const row = await seedDelivery();

      await expectRetryAt(service().delivery.deliver(row.id, first), later(HOUR));
    });

    it('sends once the block has passed, and a later block always wins', async () => {
      await rateLimits.block(`channel:${channel.externalId}`, later(-SECOND));
      await rateLimits.block('global', later(-2 * SECOND));
      await rateLimits.block('global', later(-5 * SECOND));
      expect(await bucket('global')).toEqual(later(-2 * SECOND));
      const { delivery, requests } = service(jsonResponse(200, { id: '1' }));
      const row = await seedDelivery();

      await delivery.deliver(row.id, first);

      expect(requests).toHaveLength(1);
      expect(await reload(row.id)).toMatchObject({ status: DeliveryStatuses.sent });
    });

    it('a capacity wait never fails the delivery on the final attempt, and a 429 there stays queued', async () => {
      await rateLimits.block('global', later(HOUR));
      const row = await seedDelivery();

      await expectRetryAt(service().delivery.deliver(row.id, last), later(HOUR));
      expect(await reload(row.id)).toMatchObject({ status: DeliveryStatuses.queued });

      await t.db.delete(discordRateLimits);
      const limited = service(
        jsonResponse(429, { message: 'slow down', retry_after: 2 }, { 'X-RateLimit-Scope': 'user' }),
      );
      await expectRetryAt(limited.delivery.deliver(row.id, last), later(2 * SECOND), false);
      expect(await reload(row.id)).toMatchObject({ status: DeliveryStatuses.queued, responseCode: 429 });
    });

    it('fails a delivery still waiting for capacity 24 hours after it was queued', async () => {
      await rateLimits.block('global', later(48 * HOUR));
      const row = await seedDelivery();

      await service().delivery.deliver(row.id, { isFinalAttempt: false, now: later(24 * HOUR) });

      expect(await reload(row.id)).toMatchObject({
        status: DeliveryStatuses.failed,
        error: DeliveryReasons.expired(DeliveryReasons.rateLimited),
      });
    });
  });

  describe('per-workspace fairness', () => {
    it('waits for the oldest send of the last minute to age out at 120 sends', async () => {
      await seedSent(120, index => later(-50 * SECOND + index * 100));
      const row = await seedDelivery();

      await expectRetryAt(service().delivery.deliver(row.id, first), later(10 * SECOND));

      expect(await reload(row.id)).toMatchObject({ error: DeliveryReasons.workspaceLimit });
    });

    it('spreads the wake-ups over the next window (jitter)', async () => {
      await seedSent(120, index => later(-50 * SECOND + index * 100));
      const row = await seedDelivery();

      // The oldest send ages out at +10 s; random() = 0.5 adds half a window.
      await expectRetryAt(serviceWith(() => 0.5).delivery.deliver(row.id, first), later(40 * SECOND));
    });

    it('sends at 119, and ignores sends older than a minute and other workspaces', async () => {
      await seedSent(119, () => later(-10 * SECOND));
      await seedSent(5, () => later(-61 * SECOND));
      const other = await seedChannel(t.db, await seedWorkspace(t.db, 'Other'));
      const otherRows = await Promise.all(Array.from({ length: 3 }, async () => await seedDelivery(other)));
      await t.db
        .update(notificationDeliveries)
        .set({ status: DeliveryStatuses.sent, sentAt: later(-SECOND) })
        .where(eq(notificationDeliveries.workspaceId, other.workspaceId));
      expect(otherRows).toHaveLength(3);
      const { delivery, requests } = service(jsonResponse(200, { id: '1' }));
      const row = await seedDelivery();

      await delivery.deliver(row.id, first);

      expect(requests).toHaveLength(1);
    });
  });

  describe('idempotency and missing pieces', () => {
    it('a delivery already sent is a no-op (a second or overlapping run)', async () => {
      const { delivery, requests } = service(jsonResponse(200, { id: '999' }));
      const row = await seedDelivery();
      await delivery.deliver(row.id, first);

      await delivery.deliver(row.id, first);
      await delivery.deliver(row.id, last);

      expect(requests).toHaveLength(1);
      expect(await reload(row.id)).toMatchObject({ status: DeliveryStatuses.sent, attempts: 1 });
    });

    it('a failed delivery is never retried by a later run', async () => {
      const { delivery } = service(jsonResponse(400, { message: 'bad', code: DiscordJsonErrorCodes.InvalidFormBody }));
      const row = await seedDelivery();
      await delivery.deliver(row.id, first);

      await service().delivery.deliver(row.id, first);

      expect(await reload(row.id)).toMatchObject({ status: DeliveryStatuses.failed });
    });

    it('a delivery whose channel was deleted is suppressed', async () => {
      const row = await seedDelivery();
      await t.db.delete(notificationChannels).where(eq(notificationChannels.id, channel.id));

      await service().delivery.deliver(row.id, first);

      expect(await reload(row.id)).toMatchObject({
        status: DeliveryStatuses.suppressed,
        channelId: null,
        error: DeliveryReasons.channelDeleted,
      });
    });

    it('a pruned delivery (gone with its event) is a no-op', async () => {
      await expect(service().delivery.deliver(randomUUID(), first)).resolves.toBeUndefined();
    });

    it('without a Discord bot token: waits an hour at a time for free, and expires after 24 hours', async () => {
      const unconfigured = new DeliveryService({
        deliveries,
        channels,
        rateLimits,
        discord: undefined,
        random: () => 0,
      });
      const row = await seedDelivery();

      await expectRetryAt(unconfigured.deliver(row.id, last), later(HOUR));
      expect(await reload(row.id)).toMatchObject({
        status: DeliveryStatuses.queued,
        error: DeliveryReasons.notConfigured,
        nextAttemptAt: later(HOUR),
      });

      await unconfigured.deliver(row.id, { isFinalAttempt: false, now: later(25 * HOUR) });
      expect(await reload(row.id)).toMatchObject({
        status: DeliveryStatuses.failed,
        error: DeliveryReasons.expired(DeliveryReasons.notConfigured),
        nextAttemptAt: null,
      });
    });

    it('fails a channel whose Discord id is not a snowflake without calling Discord', async () => {
      await t.db
        .update(notificationChannels)
        .set({ externalId: '../guilds/1' })
        .where(eq(notificationChannels.id, channel.id));
      const row = await seedDelivery();

      await service().delivery.deliver(row.id, first);

      expect(await reload(row.id)).toMatchObject({
        status: DeliveryStatuses.failed,
        error: DeliveryReasons.invalidChannelId,
      });
    });
  });

  describe('claiming and the nonce (no double post)', () => {
    it('posts with the delivery id as an enforced 22-character nonce', async () => {
      const { delivery, requests } = service(jsonResponse(200, { id: '1' }));
      const row = await seedDelivery();

      await delivery.deliver(row.id, first);

      const body = JSON.parse(requests[0]?.body ?? '{}') as { nonce?: string; enforce_nonce?: boolean };
      expect(body.nonce).toBe(deliveryNonce(row.id));
      expect(body.nonce).toHaveLength(22);
      expect(body.enforce_nonce).toBe(true);
      expect(deliveryNonce('00010203-0405-0607-0809-0a0b0c0d0e0f')).toBe('AAECAwQFBgcICQoLDA0ODw');
    });

    it('does not call Discord while another run holds a fresh claim, and comes back when it turns stale', async () => {
      const row = await seedDelivery();
      await deliveries.claimForSending(row.id, later(-30 * SECOND), later(-HOUR));

      await expectRetryAt(service().delivery.deliver(row.id, first), later(90 * SECOND));

      expect(await reload(row.id)).toMatchObject({ status: DeliveryStatuses.sending, attempts: 1 });
    });

    it('resends a stale claim left by a run that died, with the same nonce', async () => {
      const row = await seedDelivery();
      await deliveries.claimForSending(row.id, later(-3 * 60 * SECOND), later(-HOUR));
      const { delivery, requests } = service(jsonResponse(200, { id: '77' }));

      await delivery.deliver(row.id, first);

      expect(requests).toHaveLength(1);
      expect(requests[0]?.body).toContain(deliveryNonce(row.id));
      expect(await reload(row.id)).toMatchObject({
        status: DeliveryStatuses.sent,
        externalMessageId: '77',
        attempts: 2,
        sendingAt: null,
      });
    });

    it('of two runs racing for one delivery, only one claims it', async () => {
      const row = await seedDelivery();
      const claims = await Promise.all([
        deliveries.claimForSending(row.id, NOW, later(-HOUR)),
        deliveries.claimForSending(row.id, NOW, later(-HOUR)),
      ]);
      expect(claims.filter(claim => claim !== undefined)).toHaveLength(1);
    });
  });

  describe('reconcile and prune', () => {
    it('fails unsettled deliveries whose job is no longer live, and leaves the rest alone', async () => {
      const jobRepo = new JobRepo(t.db);
      const insertJob = async (deliveryId: string) =>
        await jobRepo.insert({
          kind: NotificationJobKinds.deliver,
          payload: { deliveryId },
          runAt: NOW,
          workspaceId,
          maxAttempts: 8,
          dedupeKey: deliveryId,
        });
      const orphan = await seedDelivery();
      const sending = await seedDelivery();
      await deliveries.claimForSending(sending.id, NOW, later(-HOUR));
      const withLiveJob = await seedDelivery();
      await insertJob(withLiveJob.id);
      const withDeadJob = await seedDelivery();
      const { job } = await insertJob(withDeadJob.id);
      await t.db.update(jobs).set({ status: JobStatuses.dead }).where(eq(jobs.id, job.id));
      const sent = await seedDelivery();
      await t.db
        .update(notificationDeliveries)
        .set({ status: DeliveryStatuses.sent })
        .where(eq(notificationDeliveries.id, sent.id));

      expect(await service().delivery.reconcile()).toBe(3);

      expect(await reload(orphan.id)).toMatchObject({
        status: DeliveryStatuses.failed,
        error: DeliveryReasons.orphaned,
      });
      expect(await reload(sending.id)).toMatchObject({ status: DeliveryStatuses.failed });
      expect(await reload(withDeadJob.id)).toMatchObject({ status: DeliveryStatuses.failed });
      expect(await reload(withLiveJob.id)).toMatchObject({ status: DeliveryStatuses.queued });
      expect(await reload(sent.id)).toMatchObject({ status: DeliveryStatuses.sent });
    });

    it('prunes rate limit buckets whose block has ended', async () => {
      await rateLimits.block('global', later(-SECOND));
      await rateLimits.block(`channel:${channel.externalId}`, later(SECOND));

      expect(await service().delivery.pruneRateLimits(NOW)).toBe(1);

      expect(await bucket('global')).toBeUndefined();
      expect(await bucket(`channel:${channel.externalId}`)).toEqual(later(SECOND));
    });
  });
});
