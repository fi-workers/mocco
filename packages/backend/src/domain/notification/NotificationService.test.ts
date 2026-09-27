import { randomUUID } from 'node:crypto';

import { DomainEventTypes } from '@mocco/common/events';
import { DeliveryStatuses, Severities } from '@mocco/common/notification';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type EventBus, type PublishInput } from '@backend/domain/events/EventBus';
import { createEventBus } from '@backend/domain/events/subscriptions';
import { PostgresJobQueue } from '@backend/domain/jobs/PostgresJobQueue';
import { JobRepo } from '@backend/domain/jobs/repos/job.repo';
import { NotificationJobKinds, NotificationSubscribers } from '@backend/domain/notification/constants';
import { seedChannel, seedRule, seedWorkspace } from '@backend/domain/notification/testing/seed';
import { domainEventDeliveries, jobs, notificationDeliveries } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

const T0 = new Date('2026-09-25T00:00:00.000Z');
const APP_ORIGIN = 'https://www.mocco.club';

const gatePending = (workspaceId: string, facts: { repo: string; pipeline: string; gate: string }): PublishInput => {
  const runId = randomUUID();
  return {
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
  };
};

describe('NotificationService fan-out (pglite)', () => {
  let t: TestDb;
  let bus: EventBus;
  let kicked: string[];

  beforeEach(async () => {
    t = await createTestDb();
    kicked = [];
    const queue = new PostgresJobQueue({
      jobs: new JobRepo(t.db),
      now: () => T0,
      // Record kicks instead of running them: these tests stop at the queued delivery.
      runOne: async id => {
        kicked.push(id);
        return await Promise.resolve(null);
      },
      // The recorded runOne resolves at once; nothing to keep alive.
      waitUntil: () => {},
    });
    bus = createEventBus({ db: t.db, queue, now: () => T0, appOrigin: APP_ORIGIN });
  });

  afterEach(async () => {
    await t.close();
  });

  const facts = { repo: 'fi-workers/api', pipeline: 'deploy', gate: 'production' };

  /** Publish and hand the event to the fan-out, as `events.deliver` would. */
  const publishAndFanOut = async (input: PublishInput) => {
    const { event } = await bus.publish(input);
    await bus.deliver(event.id, NotificationSubscribers.gate.name);
    return event;
  };

  const deliveriesOf = async (eventId: string) =>
    await t.db.select().from(notificationDeliveries).where(eq(notificationDeliveries.eventId, eventId));

  const deliverJobs = async () => await t.db.select().from(jobs).where(eq(jobs.kind, NotificationJobKinds.deliver));

  it('subscribes to governance and every inbound source family', () => {
    expect(bus.subscribersFor('gate.pending')).toEqual([NotificationSubscribers.gate.name]);
    expect(bus.subscribersFor('run.failed')).toEqual([NotificationSubscribers.run.name]);
    expect(bus.subscribersFor('sentry.issue.created')).toEqual([NotificationSubscribers.sentry.name]);
    expect(bus.subscribersFor('vercel.deployment.error')).toEqual([NotificationSubscribers.vercel.name]);
    expect(bus.subscribersFor('github.push')).toEqual([NotificationSubscribers.github.name]);
  });

  it('queues one delivery per matching channel, each with a kicked job deduped by its id', async () => {
    const workspaceId = await seedWorkspace(t.db);
    const everyGate = await seedChannel(t.db, workspaceId, 'all-gates');
    const productionOnly = await seedChannel(t.db, workspaceId, 'prod');
    const otherPipeline = await seedChannel(t.db, workspaceId, 'other');
    const runsOnly = await seedChannel(t.db, workspaceId, 'runs');
    await seedChannel(t.db, workspaceId, 'no-rules');
    await seedRule(t.db, everyGate, { eventType: 'gate.*' });
    await seedRule(t.db, productionOnly, { eventType: 'gate.pending', filter: { gate: 'production' } });
    await seedRule(t.db, otherPipeline, { eventType: 'gate.pending', filter: { pipeline: 'release' } });
    await seedRule(t.db, runsOnly, { eventType: 'run.*' });

    const event = await publishAndFanOut(gatePending(workspaceId, facts));

    const deliveries = await deliveriesOf(event.id);
    expect(new Set(deliveries.map(delivery => delivery.channelId))).toEqual(new Set([everyGate.id, productionOnly.id]));
    expect(deliveries.every(delivery => delivery.status === DeliveryStatuses.queued)).toBe(true);
    expect(deliveries[0]?.message).toMatchObject({
      title: 'Approval needed: deploy · production',
      severity: Severities.warning,
      url: `${APP_ORIGIN}/workspaces/${workspaceId}/runs/${(event.payload as { runId: string }).runId}`,
    });
    const queued = await deliverJobs();
    expect(new Set(queued.map(job => job.dedupeKey))).toEqual(new Set(deliveries.map(delivery => delivery.id)));
    expect(queued.every(job => job.workspaceId === workspaceId && job.maxAttempts === 8)).toBe(true);
    expect(queued.map(job => job.payload)).toEqual(
      expect.arrayContaining(deliveries.map(delivery => ({ deliveryId: delivery.id }))),
    );
    // The two notification jobs were kicked (after their commit), besides the event jobs.
    expect(kicked).toEqual(expect.arrayContaining(queued.map(job => job.id)));
  });

  it('records the matching rule on the delivery', async () => {
    const workspaceId = await seedWorkspace(t.db);
    const channel = await seedChannel(t.db, workspaceId);
    await seedRule(t.db, channel, { eventType: 'run.*' });
    await seedRule(t.db, channel, { eventType: 'gate.pending' });
    await seedRule(t.db, channel, { eventType: 'gate.resumed' });

    const event = await publishAndFanOut(gatePending(workspaceId, facts));

    const [delivery] = await deliveriesOf(event.id);
    const rules = await t.db.query.notificationRules.findMany();
    expect(delivery?.ruleId).toBe(rules.find(rule => rule.eventType === 'gate.pending')?.id);
  });

  it('creates no duplicate delivery or job when the event is handed over again', async () => {
    const workspaceId = await seedWorkspace(t.db);
    const channel = await seedChannel(t.db, workspaceId);
    await seedRule(t.db, channel);

    const event = await publishAndFanOut(gatePending(workspaceId, facts));
    // A crash after the subscriber returned but before the ledger write: delivered again.
    await t.db.delete(domainEventDeliveries).where(eq(domainEventDeliveries.eventId, event.id));
    await bus.deliver(event.id, NotificationSubscribers.gate.name);
    // A repeat publish with the same dedupe key fans out again too.
    const input = { ...gatePending(workspaceId, facts), dedupeKey: 'gate.pending:same' };
    const first = await bus.publish(input);
    await bus.deliver(first.event.id, NotificationSubscribers.gate.name);
    await bus.publish(input);
    await t.db.delete(domainEventDeliveries).where(eq(domainEventDeliveries.eventId, first.event.id));
    await bus.deliver(first.event.id, NotificationSubscribers.gate.name);

    expect(await deliveriesOf(event.id)).toHaveLength(1);
    expect(await deliveriesOf(first.event.id)).toHaveLength(1);
    expect(await deliverJobs()).toHaveLength(2);
  });

  it('skips disabled channels', async () => {
    const workspaceId = await seedWorkspace(t.db);
    const channel = await seedChannel(t.db, workspaceId);
    await seedRule(t.db, channel);
    await t.db.update(t.schema.notificationChannels).set({ status: 'disabled', disabledReason: 'Missing Access' });

    const event = await publishAndFanOut(gatePending(workspaceId, facts));

    expect(await deliveriesOf(event.id)).toHaveLength(0);
    expect(await deliverJobs()).toHaveLength(0);
  });

  it("never delivers an event of workspace A to workspace B's channels", async () => {
    const workspaceA = await seedWorkspace(t.db, 'A');
    const workspaceB = await seedWorkspace(t.db, 'B');
    const channelA = await seedChannel(t.db, workspaceA);
    const channelB = await seedChannel(t.db, workspaceB);
    // B's rule would match the event exactly.
    await seedRule(t.db, channelA);
    await seedRule(t.db, channelB, { eventType: 'gate.pending', filter: facts });

    const event = await publishAndFanOut(gatePending(workspaceA, facts));

    const deliveries = await deliveriesOf(event.id);
    expect(deliveries.map(delivery => [delivery.workspaceId, delivery.channelId])).toEqual([[workspaceA, channelA.id]]);
    const all = await t.db.select().from(notificationDeliveries);
    expect(all.some(delivery => delivery.workspaceId === workspaceB)).toBe(false);
  });

  it('deletes deliveries with their event when events are pruned', async () => {
    const workspaceId = await seedWorkspace(t.db);
    const channel = await seedChannel(t.db, workspaceId);
    await seedRule(t.db, channel);
    const event = await publishAndFanOut(gatePending(workspaceId, facts));

    await t.db.delete(t.schema.domainEvents).where(eq(t.schema.domainEvents.id, event.id));

    expect(await deliveriesOf(event.id)).toHaveLength(0);
  });
});
