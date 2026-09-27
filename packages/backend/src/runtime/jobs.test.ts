import { randomUUID } from 'node:crypto';

import { DomainEventTypes } from '@mocco/common/events';
import { JobStatuses } from '@mocco/common/jobs';
import { DeliveryStatuses } from '@mocco/common/notification';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EventJobKinds } from '@backend/domain/events/EventBus';
import { createEventBus } from '@backend/domain/events/subscriptions';
import { PostgresJobQueue } from '@backend/domain/jobs/PostgresJobQueue';
import { JobKinds } from '@backend/domain/jobs/prune';
import { JobRepo } from '@backend/domain/jobs/repos/job.repo';
import { NotificationJobKinds } from '@backend/domain/notification/constants';
import { DiscordApi } from '@backend/domain/notification/senders/discord';
import { createFakeDiscordFetch, jsonResponse } from '@backend/domain/notification/testing/fake-discord-fetch';
import { seedChannel, seedRule, seedWorkspace } from '@backend/domain/notification/testing/seed';
import { jobs, jobSchedules, notificationDeliveries } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { createJobRunner } from '@backend/runtime/jobs';

const T0 = new Date('2026-09-25T00:00:00.000Z');

describe('job runtime composition (pglite)', () => {
  let t: TestDb;

  beforeEach(async () => {
    t = await createTestDb();
  });

  afterEach(async () => {
    await t.close();
  });

  it('registers every domain handler and the platform schedules', async () => {
    const runner = createJobRunner(t.db, {
      now: () => T0,
      random: () => 0,
      workerId: 'test',
      waitUntil: () => {},
      appOrigin: 'https://mocco.test',
      discord: undefined,
    });

    const report = await runner.tick({ budgetMs: 10_000, maxJobs: 10 });

    expect(report).toMatchObject({ ran: 4, errors: [], outcomes: { succeeded: 4 } });
    const schedules = await t.db.select().from(jobSchedules);
    expect(new Set(schedules.map(schedule => schedule.kind))).toEqual(
      new Set([JobKinds.prune, EventJobKinds.prune, NotificationJobKinds.reconcile, NotificationJobKinds.prune]),
    );
    expect(schedules.every(schedule => schedule.workspaceId === null)).toBe(true);
    const ran = await t.db.select().from(jobs);
    expect(ran.every(job => job.status === JobStatuses.succeeded)).toBe(true);
  });

  it('delivers a governance event to a Discord channel end to end', async () => {
    const workspaceId = await seedWorkspace(t.db);
    const channel = await seedChannel(t.db, workspaceId);
    await seedRule(t.db, channel, { eventType: 'gate.pending' });
    const fake = createFakeDiscordFetch(jsonResponse(200, { id: '4242' }));
    const kicked: Promise<unknown>[] = [];
    const runner = createJobRunner(t.db, {
      now: () => T0,
      random: () => 0,
      workerId: 'test',
      waitUntil: promise => {
        kicked.push(promise);
      },
      appOrigin: 'https://mocco.test',
      discord: new DiscordApi({ fetch: fake.fetch, botToken: 'bot', now: () => T0 }),
    });
    // A publisher's bus (its kicks are dropped: the tick below runs the event job).
    const publisher = createEventBus({
      db: t.db,
      queue: new PostgresJobQueue({
        jobs: new JobRepo(t.db),
        now: () => T0,
        runOne: async () => await Promise.resolve(null),
        waitUntil: () => {},
      }),
      now: () => T0,
      appOrigin: 'https://mocco.test',
    });
    const runId = randomUUID();
    const facts = { repo: 'fi-workers/api', pipeline: 'deploy', gate: 'production' };
    await publisher.publish({
      type: DomainEventTypes.gatePending,
      workspaceId,
      subject: { type: 'run_gate', id: randomUUID() },
      payload: {
        workspaceId,
        runId,
        repoFullName: facts.repo,
        pipelineName: facts.pipeline,
        commitSha: 'abc1234',
        linkPath: `/workspaces/${workspaceId}/runs/${runId}`,
        gateName: facts.gate,
        gateItemIndex: 1,
        facts,
      },
    });

    // The tick hands the event to the fan-out, which queues and kicks the delivery.
    await runner.tick({ budgetMs: 10_000, maxJobs: 10 });
    await Promise.all(kicked);

    const [delivery] = await t.db.select().from(notificationDeliveries);
    expect(delivery).toMatchObject({ status: DeliveryStatuses.sent, externalMessageId: '4242' });
    expect(fake.requests.map(request => new URL(request.url).pathname)).toEqual([
      `/api/v10/channels/${channel.externalId}/messages`,
    ]);
    const deliverJob = await t.db.select().from(jobs).where(eq(jobs.kind, NotificationJobKinds.deliver));
    expect(deliverJob.map(job => job.status)).toEqual([JobStatuses.succeeded]);
  });
});
