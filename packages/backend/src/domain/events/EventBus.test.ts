import { randomUUID } from 'node:crypto';

import { DomainEventTypes } from '@mocco/common/events';
import { JobStatuses } from '@mocco/common/jobs';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DomainEventPayloadError,
  InvalidSubscriptionError,
  UnknownDomainEventTypeError,
} from '@backend/domain/events/errors';
import {
  deliverEvent,
  EventBus,
  EventJobKinds,
  type DeliveredEvent,
  type PublishInput,
} from '@backend/domain/events/EventBus';
import { createEventHandlers, createPruneEventsHandler, EVENT_RETENTION_MS } from '@backend/domain/events/jobs';
import { DomainEventRepo } from '@backend/domain/events/repos/domain-event.repo';
import { JobHandlerRegistry } from '@backend/domain/jobs/handlers';
import { JobRunner } from '@backend/domain/jobs/JobRunner';
import { PostgresJobQueue } from '@backend/domain/jobs/PostgresJobQueue';
import { JobScheduleRepo } from '@backend/domain/jobs/repos/job-schedule.repo';
import { JobRepo } from '@backend/domain/jobs/repos/job.repo';
import { expectOne } from '@backend/infra/db/rows';
import { domainEventDeliveries, domainEvents, jobs, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

const T0 = new Date('2026-09-25T00:00:00.000Z');
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

describe('EventBus (pglite)', () => {
  let t: TestDb;
  let clock: { now: Date };
  let events: DomainEventRepo;
  let bus: EventBus;
  let queue: PostgresJobQueue;
  let runner: JobRunner;
  let kicked: Promise<unknown>[];
  let workspaceId: string;

  const now = () => clock.now;
  const advanceClock = (ms: number) => {
    clock.now = new Date(clock.now.getTime() + ms);
  };

  beforeEach(async () => {
    t = await createTestDb();
    clock = { now: T0 };
    kicked = [];
    const jobRepo = new JobRepo(t.db);
    events = new DomainEventRepo(t.db);
    // The same wiring as production: the bus enqueues through the queue, the runner
    // runs `events.deliver` through the bus. The queue reaches the runner lazily.
    const holder: { runner?: JobRunner } = {};
    queue = new PostgresJobQueue({
      jobs: jobRepo,
      now,
      runOne: async id => await holder.runner?.runOne(id),
      waitUntil: promise => {
        kicked.push(promise);
      },
    });
    bus = new EventBus({ events, queue, now });
    runner = new JobRunner({
      jobs: jobRepo,
      schedules: new JobScheduleRepo(t.db, jobRepo),
      handlers: new JobHandlerRegistry(createEventHandlers({ bus, events })),
      now,
      random: () => 0,
      workerId: 'test',
    });
    holder.runner = runner;
    workspaceId = expectOne(await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning()).id;
  });

  const drainKicks = async () => {
    const inFlight = [...kicked];
    kicked.length = 0;
    await Promise.all(inFlight);
  };
  const jobStatuses = async () => {
    const rows = await t.db.select().from(jobs).where(eq(jobs.kind, EventJobKinds.deliver));
    return rows.map(job => job.status);
  };

  afterEach(async () => {
    // A kicked run still in flight must finish before the database closes.
    await drainKicks();
    await t.close();
  });
  const tick = async () => await runner.tick({ budgetMs: 60_000, maxJobs: 100 });
  const jobRows = async () => await t.db.select().from(jobs).where(eq(jobs.kind, EventJobKinds.deliver));

  const runSucceeded = (overrides: Partial<Extract<PublishInput, { type: 'run.succeeded' }>> = {}): PublishInput => {
    const runId = randomUUID();
    return {
      type: DomainEventTypes.runSucceeded,
      workspaceId,
      subject: { type: 'run', id: runId },
      payload: {
        workspaceId,
        runId,
        repoFullName: 'fi-workers/api',
        pipelineName: 'deploy',
        commitSha: 'abc123',
        linkPath: `/workspaces/${workspaceId}/runs/${runId}`,
        facts: { repo: 'fi-workers/api', pipeline: 'deploy' },
      },
      ...overrides,
    };
  };

  describe('publish', () => {
    it('stores the event and enqueues one kicked delivery per matching subscriber', async () => {
      bus.subscribe('run.succeeded', 'test.exact', async () => {});
      bus.subscribe('run.*', 'test.wildcard', async () => {});
      bus.subscribe('gate.*', 'test.other', async () => {});

      const { event, created, subscribers } = await bus.publish(runSucceeded());

      expect(created).toBe(true);
      expect(subscribers).toEqual(['test.exact', 'test.wildcard']);
      const [row] = await t.db.select().from(domainEvents);
      expect(row).toMatchObject({
        id: event.id,
        workspaceId,
        type: 'run.succeeded',
        subjectType: 'run',
        occurredAt: T0,
        projectId: null,
      });
      const queued = await jobRows();
      expect(queued.map(job => job.dedupeKey).toSorted((a, b) => (a ?? '').localeCompare(b ?? ''))).toEqual([
        `${event.id}:test.exact`,
        `${event.id}:test.wildcard`,
      ]);
      expect(queued.every(job => job.workspaceId === workspaceId)).toBe(true);
      expect(kicked).toHaveLength(2);
    });

    it('stores an event nobody subscribes to without enqueueing anything', async () => {
      const { subscribers } = await bus.publish(runSucceeded());
      expect(subscribers).toEqual([]);
      expect(await t.db.select().from(domainEvents)).toHaveLength(1);
      expect(await jobRows()).toHaveLength(0);
    });

    it('rejects a payload that fails the catalog schema and writes nothing', async () => {
      bus.subscribe('run.*', 'test.any', async () => {});
      const input = runSucceeded();
      const broken = { ...input, payload: { ...input.payload, runId: 'not-a-uuid' } } as PublishInput;

      await expect(bus.publish(broken)).rejects.toBeInstanceOf(DomainEventPayloadError);

      expect(await t.db.select().from(domainEvents)).toHaveLength(0);
      expect(await jobRows()).toHaveLength(0);
    });

    it('rejects a type outside the catalog', async () => {
      const unknown = { ...runSucceeded(), type: 'run.exploded' } as unknown as PublishInput;
      await expect(bus.publish(unknown)).rejects.toBeInstanceOf(UnknownDomainEventTypeError);
    });

    it('is idempotent on a dedupe key: the second publish returns the first event, and the subscriber runs once', async () => {
      let calls = 0;
      bus.subscribe('run.*', 'test.any', async () => {
        calls += 1;
      });
      const first = await bus.publish(runSucceeded({ dedupeKey: 'receipt-1' }));
      await drainKicks();
      const second = await bus.publish(runSucceeded({ dedupeKey: 'receipt-1' }));
      await drainKicks();

      expect(second).toEqual({ event: first.event, created: false, subscribers: ['test.any'] });
      expect(await t.db.select().from(domainEvents)).toHaveLength(1);
      // The repeat re-enqueues (the first job had finished), and the ledger makes it a no-op.
      expect(calls).toBe(1);
      expect(await jobStatuses()).toEqual([JobStatuses.succeeded, JobStatuses.succeeded]);
    });

    it('a repeat publish repairs a fan-out that died between the insert and the enqueue', async () => {
      bus.subscribe('run.succeeded', 'test.repair', async () => {});
      const input = runSucceeded({ dedupeKey: 'run.succeeded:crashed' });
      // The event row exists but its delivery jobs were never written (crash after insert).
      await events.insert({
        workspaceId,
        projectId: null,
        type: input.type,
        subjectType: input.subject.type,
        subjectId: input.subject.id,
        payload: input.payload,
        dedupeKey: 'run.succeeded:crashed',
        occurredAt: T0,
      });
      expect(await jobRows()).toHaveLength(0);

      const retry = await bus.publish(input);
      await drainKicks();

      expect(retry).toMatchObject({ created: false, subscribers: ['test.repair'] });
      expect(await jobStatuses()).toEqual([JobStatuses.succeeded]);
      expect(await t.db.select().from(domainEventDeliveries)).toHaveLength(1);
    });

    it('scopes the dedupe key to the workspace', async () => {
      const otherWorkspaceId = expectOne(
        await t.db.insert(workspaces).values({ name: 'W2', slug: randomUUID() }).returning(),
      ).id;
      await bus.publish(runSucceeded({ dedupeKey: 'k' }));
      const other = await bus.publish(runSucceeded({ workspaceId: otherWorkspaceId, dedupeKey: 'k' }));
      expect(other.created).toBe(true);
    });
  });

  describe('subscribe', () => {
    it('rejects a duplicate subscriber name', () => {
      bus.subscribe('run.*', 'test.same', async () => {});
      expect(() => {
        bus.subscribe('gate.*', 'test.same', async () => {});
      }).toThrow(InvalidSubscriptionError);
    });

    it('rejects an exact pattern outside the catalog', () => {
      expect(() => {
        bus.subscribe('run.exploded' as 'run.succeeded', 'test.typo', async () => {});
      }).toThrow(InvalidSubscriptionError);
    });
  });

  describe('delivery', () => {
    it('delivers the parsed event to the subscriber through the kicked job', async () => {
      const received: DeliveredEvent<'run.succeeded' | 'run.failed'>[] = [];
      bus.subscribe('run.*', 'test.recorder', async event => {
        received.push(event);
      });

      const { event } = await bus.publish(runSucceeded());
      await drainKicks();

      expect(received).toEqual([
        expect.objectContaining({ id: event.id, type: 'run.succeeded', payload: event.payload }),
      ]);
      const [job] = await jobRows();
      expect(job?.status).toBe(JobStatuses.succeeded);
      expect(await t.db.select().from(domainEventDeliveries)).toEqual([
        { eventId: event.id, subscriber: 'test.recorder', deliveredAt: T0 },
      ]);
    });

    it('calls a subscriber once per event even when the delivery is enqueued twice', async () => {
      let calls = 0;
      bus.subscribe('run.succeeded', 'test.counter', async () => {
        calls += 1;
      });
      const { event } = await bus.publish(runSucceeded());
      await drainKicks();

      // A second delivery job for the same (event, subscriber) after the first finished
      // (the live-job dedupe no longer blocks it) — e.g. a reconciler re-enqueueing.
      const again = await queue.enqueue(
        deliverEvent,
        { eventId: event.id, subscriber: 'test.counter' },
        { dedupeKey: `${event.id}:test.counter` },
      );
      expect(again.created).toBe(true);
      await tick();

      expect(calls).toBe(1);
      expect(await jobStatuses()).toEqual([JobStatuses.succeeded, JobStatuses.succeeded]);
    });

    it('retries the job when the subscriber throws, then delivers once it succeeds', async () => {
      let calls = 0;
      bus.subscribe('run.succeeded', 'test.flaky', async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error('discord is down');
        }
      });
      await bus.publish(runSucceeded());
      await drainKicks();

      const [failed] = await jobRows();
      expect(failed).toMatchObject({ status: JobStatuses.queued, attempts: 1, lastError: 'discord is down' });
      expect(await t.db.select().from(domainEventDeliveries)).toHaveLength(0);

      advanceClock(MINUTE);
      await tick();
      await tick();

      expect(calls).toBe(2);
      const [done] = await jobRows();
      expect(done?.status).toBe(JobStatuses.succeeded);
      expect(await t.db.select().from(domainEventDeliveries)).toHaveLength(1);
    });

    it('treats an unregistered subscriber as a retryable failure', async () => {
      const { event } = await bus.publish(runSucceeded());
      const { job } = await queue.enqueue(deliverEvent, { eventId: event.id, subscriber: 'test.missing' });
      await tick();
      const [row] = await t.db.select().from(jobs).where(eq(jobs.id, job.id));
      expect(row).toMatchObject({ status: JobStatuses.queued, attempts: 1 });
    });

    it('is a no-op for an event that was pruned before its delivery ran', async () => {
      let calls = 0;
      bus.subscribe('run.succeeded', 'test.late', async () => {
        calls += 1;
      });
      await bus.publish(runSucceeded());
      await t.db.delete(domainEvents);
      await tick();
      expect(calls).toBe(0);
      expect(await jobStatuses()).toEqual([JobStatuses.succeeded]);
    });
  });

  describe('events.prune', () => {
    it('deletes events older than 30 days with their deliveries, and keeps newer ones', async () => {
      bus.subscribe('run.succeeded', 'test.sink', async () => {});
      const old = await bus.publish(runSucceeded({ occurredAt: new Date(T0.getTime() - EVENT_RETENTION_MS - DAY) }));
      const recent = await bus.publish(runSucceeded({ occurredAt: new Date(T0.getTime() - EVENT_RETENTION_MS + DAY) }));
      await drainKicks();

      await createPruneEventsHandler(events).run(
        {},
        {
          jobId: randomUUID(),
          kind: EventJobKinds.prune,
          attempt: 1,
          workspaceId: null,
          now,
          deadline: new Date(T0.getTime() + MINUTE),
        },
      );

      const remaining = await t.db.select().from(domainEvents);
      const deliveries = await t.db.select().from(domainEventDeliveries);
      expect(remaining.map(row => row.id)).toEqual([recent.event.id]);
      expect(deliveries.map(row => row.eventId)).toEqual([recent.event.id]);
      expect(old.created).toBe(true);
    });

    it('deletes in bounded batches and reports the count', async () => {
      const stale = new Date(T0.getTime() - EVENT_RETENTION_MS - DAY);
      await Promise.all(Array.from({ length: 5 }, async () => await bus.publish(runSucceeded({ occurredAt: stale }))));
      const before = new Date(T0.getTime() - EVENT_RETENTION_MS);

      expect(await events.pruneBefore(before, 2)).toBe(2);
      expect(await events.pruneBefore(before, 2)).toBe(2);
      expect(await events.pruneBefore(before, 2)).toBe(1);
      expect(await events.pruneBefore(before, 2)).toBe(0);
    });

    it('the prune job keeps deleting batches until the old events are gone', async () => {
      const stale = new Date(T0.getTime() - EVENT_RETENTION_MS - DAY);
      await Promise.all(Array.from({ length: 5 }, async () => await bus.publish(runSucceeded({ occurredAt: stale }))));

      await createPruneEventsHandler(events, { batchSize: 2 }).run(
        {},
        {
          jobId: randomUUID(),
          kind: EventJobKinds.prune,
          attempt: 1,
          workspaceId: null,
          now,
          deadline: new Date(T0.getTime() + MINUTE),
        },
      );

      expect(await t.db.select().from(domainEvents)).toHaveLength(0);
    });
  });
});
