// The review repros for capacity waits, run through the real job runner: waits for
// Discord buckets and the per-workspace limit must never spend job attempts, so a
// delivery that waits many times still gets sent.
import { randomUUID } from 'node:crypto';

import { JobStatuses } from '@mocco/common/jobs';
import { DeliveryStatuses, Severities } from '@mocco/common/notification';
import { and, eq, min } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DomainEventRepo } from '@backend/domain/events/repos/domain-event.repo';
import { JobHandlerRegistry } from '@backend/domain/jobs/handlers';
import { JobRunner } from '@backend/domain/jobs/JobRunner';
import { PostgresJobQueue } from '@backend/domain/jobs/PostgresJobQueue';
import { JobScheduleRepo } from '@backend/domain/jobs/repos/job-schedule.repo';
import { JobRepo } from '@backend/domain/jobs/repos/job.repo';
import { DeliveryPolicy, NotificationJobKinds } from '@backend/domain/notification/constants';
import { createNotificationHandlers } from '@backend/domain/notification/jobs';
import { deliverNotification } from '@backend/domain/notification/NotificationService';
import { ChannelRepo, type ChannelRow } from '@backend/domain/notification/repos/channel.repo';
import { DeliveryRepo } from '@backend/domain/notification/repos/delivery.repo';
import { DiscordRateLimitRepo } from '@backend/domain/notification/repos/discord-rate-limit.repo';
import { DiscordApi } from '@backend/domain/notification/senders/discord';
import { discordChannelBucket } from '@backend/domain/notification/senders/discord-constants';
import { seedChannel, seedWorkspace } from '@backend/domain/notification/testing/seed';
import { jobs, notificationDeliveries } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type { NeutralMessage } from '@mocco/common/notification';

const SECOND = 1000;
const message: NeutralMessage = { title: 'Deploy', severity: Severities.info, fields: [], footer: 'Mocco' };

describe('capacity waits through the job runner (pglite)', () => {
  let t: TestDb;
  let clock: { now: Date };
  let sends: Date[];
  let runner: JobRunner;
  let queue: PostgresJobQueue;
  let deliveries: DeliveryRepo;
  let rateLimits: DiscordRateLimitRepo;
  let channel: ChannelRow;

  const now = () => clock.now;

  beforeEach(async () => {
    t = await createTestDb();
    // The wall clock, so the rows' created_at (DB default) matches the test clock.
    clock = { now: new Date() };
    sends = [];
    const jobRepo = new JobRepo(t.db);
    deliveries = new DeliveryRepo(t.db);
    rateLimits = new DiscordRateLimitRepo(t.db);
    let messageId = 0;
    // A Discord that accepts every post and records when it happened.
    const discordFetch: typeof fetch = async () => {
      sends.push(clock.now);
      messageId += 1;
      return await Promise.resolve(Response.json({ id: String(messageId) }));
    };
    runner = new JobRunner({
      jobs: jobRepo,
      schedules: new JobScheduleRepo(t.db, jobRepo),
      handlers: new JobHandlerRegistry(
        createNotificationHandlers({
          deliveries,
          channels: new ChannelRepo(t.db),
          rateLimits,
          discord: new DiscordApi({ fetch: discordFetch, botToken: 'bot', now }),
          random: Math.random,
        }),
      ),
      now,
      random: () => 0,
      workerId: 'test',
    });
    queue = new PostgresJobQueue({
      jobs: jobRepo,
      now,
      runOne: async () => await Promise.resolve(null),
      waitUntil: () => {},
    });
    channel = await seedChannel(t.db, await seedWorkspace(t.db));
  });

  afterEach(async () => {
    await t.close();
  });

  const queueDeliveries = async (count: number) => {
    const events = new DomainEventRepo(t.db);
    await Array.from({ length: count }).reduce<Promise<unknown>>(async previous => {
      await previous;
      const { event } = await events.insert({
        workspaceId: channel.workspaceId,
        projectId: null,
        type: 'gate.pending',
        subjectType: 'run_gate',
        subjectId: randomUUID(),
        payload: {},
        dedupeKey: null,
        occurredAt: clock.now,
      });
      return await deliveries.createQueued(
        { workspaceId: channel.workspaceId, channelId: channel.id, eventId: event.id, ruleId: null, message },
        async (delivery, executor) =>
          await queue.enqueue(
            deliverNotification,
            { deliveryId: delivery.id },
            {
              executor,
              workspaceId: channel.workspaceId,
              dedupeKey: delivery.id,
              maxAttempts: DeliveryPolicy.maxAttempts,
            },
          ),
      );
    }, Promise.resolve());
  };

  const deliverJobs = async () => await t.db.select().from(jobs).where(eq(jobs.kind, NotificationJobKinds.deliver));
  const statuses = async () => {
    const rows = await t.db.select().from(notificationDeliveries);
    return rows.map(row => row.status);
  };

  /** Run every due job, then move the clock on by 5 s (or to the next queued job, if later). */
  const drain = async (maxRounds: number) => {
    await Array.from({ length: maxRounds }).reduce<Promise<void>>(async previous => {
      await previous;
      await runner.tick({ budgetMs: 60_000, maxJobs: 5000 });
      const [next] = await t.db
        .select({ at: min(jobs.runAt) })
        .from(jobs)
        .where(and(eq(jobs.kind, NotificationJobKinds.deliver), eq(jobs.status, JobStatuses.queued)));
      const step = clock.now.getTime() + 5 * SECOND;
      clock.now = new Date(Math.max(step, next?.at?.getTime() ?? step));
    }, Promise.resolve());
  };

  it('a delivery whose channel bucket stays blocked 30 s at a time never fails, and sends once free', async () => {
    await queueDeliveries(1);
    const bucket = discordChannelBucket(channel.externalId);

    await Array.from({ length: 20 }).reduce<Promise<void>>(async previous => {
      await previous;
      await rateLimits.block(bucket, new Date(clock.now.getTime() + 30 * SECOND));
      await runner.tick({ budgetMs: 60_000, maxJobs: 10 });
      clock.now = new Date(clock.now.getTime() + 30 * SECOND);
    }, Promise.resolve());

    expect(sends).toHaveLength(0);
    expect(await statuses()).toEqual([DeliveryStatuses.queued]);
    expect(await deliverJobs()).toMatchObject([{ status: JobStatuses.queued, attempts: 0, deferrals: 0 }]);

    await runner.tick({ budgetMs: 60_000, maxJobs: 10 });
    expect(sends).toHaveLength(1);
    expect(await statuses()).toEqual([DeliveryStatuses.sent]);
  });

  it('1500 deliveries at 120 per minute all get sent, none failing and no attempt spent on waiting', async () => {
    const count = 1500;
    await queueDeliveries(count);

    await drain(400);

    const all = await statuses();
    expect(all.filter(status => status === DeliveryStatuses.sent)).toHaveLength(count);
    const jobRows = await deliverJobs();
    expect(jobRows.every(job => job.status === JobStatuses.succeeded && job.attempts === 1)).toBe(true);
    // Never more than 120 sends in any 60 s window.
    const times = sends.map(sent => sent.getTime()).toSorted((a, b) => a - b);
    const busiest = times.reduce((max, time, index) => {
      const inWindow = times.slice(index).filter(other => other < time + DeliveryPolicy.fairnessWindowMs).length;
      return Math.max(max, inWindow);
    }, 0);
    expect(busiest).toBeLessThanOrEqual(DeliveryPolicy.workspacePerMinute);
  }, 600_000);
});
