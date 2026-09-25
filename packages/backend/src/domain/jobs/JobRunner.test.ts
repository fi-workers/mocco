import { JobStatuses } from '@mocco/common/jobs';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineJob, handleJob, JobHandlerRegistry, type JobHandler } from '@backend/domain/jobs/handlers';
import { JobRunner, TickPhases } from '@backend/domain/jobs/JobRunner';
import { JobPolicy, JobTiming } from '@backend/domain/jobs/policy';
import { PostgresJobQueue } from '@backend/domain/jobs/PostgresJobQueue';
import { createPruneHandler, pruneSchedule } from '@backend/domain/jobs/prune';
import { JobScheduleRepo } from '@backend/domain/jobs/repos/job-schedule.repo';
import { JobRepo } from '@backend/domain/jobs/repos/job.repo';
import { RetryAt } from '@backend/domain/jobs/retry-at';
import { jobs, jobSchedules } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

const T0 = new Date('2026-09-25T00:00:00.000Z');
const SECOND = 1000;
const MINUTE = 60 * SECOND;

const echoJob = defineJob('test.echo', z.object({ n: z.number() }));
const failJob = defineJob('test.fail', z.object({}));
const slowJob = defineJob('test.slow', z.object({}));
const laterJob = defineJob('test.later', z.object({ untilMs: z.number() }));

describe('JobRunner (pglite)', () => {
  let t: TestDb;
  let clock: { now: Date };
  let repo: JobRepo;
  let ran: { n: number; attempt: number }[];
  let deadlines: Date[];
  let runner: JobRunner;
  let queue: PostgresJobQueue;
  let kicked: Promise<unknown>[];

  const now = () => clock.now;
  const advanceClock = (ms: number) => {
    clock.now = new Date(clock.now.getTime() + ms);
  };

  beforeEach(async () => {
    t = await createTestDb();
    clock = { now: T0 };
    ran = [];
    deadlines = [];
    kicked = [];
    repo = new JobRepo(t.db);
    const handlers: JobHandler[] = [
      handleJob(echoJob, async (payload, ctx) => {
        ran.push({ n: payload.n, attempt: ctx.attempt });
        deadlines.push(ctx.deadline);
      }),
      handleJob(failJob, async () => {
        throw new Error('boom');
      }),
      handleJob(slowJob, async () => {
        advanceClock(30 * SECOND);
      }),
      handleJob(laterJob, async payload => {
        throw new RetryAt(new Date(payload.untilMs), 'rate limited');
      }),
      createPruneHandler(repo),
    ];
    runner = new JobRunner({
      jobs: repo,
      schedules: new JobScheduleRepo(t.db, repo),
      handlers: new JobHandlerRegistry(handlers),
      now,
      random: () => 0,
      workerId: 'test',
    });
    queue = new PostgresJobQueue({
      jobs: repo,
      now,
      runOne: async id => await runner.runOne(id),
      waitUntil: promise => {
        kicked.push(promise);
      },
    });
  });

  afterEach(async () => {
    await t.close();
  });

  const read = async (id: string) => {
    const [row] = await t.db.select().from(jobs).where(eq(jobs.id, id));
    if (!row) {
      throw new Error('job row missing');
    }
    return row;
  };
  const tick = async () => await runner.tick({ budgetMs: 50 * SECOND, maxJobs: 100 });

  it('runs a due job to success with its parsed payload', async () => {
    const { job } = await queue.enqueue(echoJob, { n: 7 });

    const report = await tick();

    expect(ran).toEqual([{ n: 7, attempt: 1 }]);
    expect(report.outcomes.succeeded).toBe(1);
    expect(await read(job.id)).toMatchObject({ status: JobStatuses.succeeded, finishedAt: T0 });
  });

  it('passes the lock expiry to the handler as ctx.deadline', async () => {
    await queue.enqueue(echoJob, { n: 1 });
    await tick();
    expect(deadlines).toEqual([new Date(T0.getTime() + JobTiming.visibilityMs)]);
  });

  it('keeps draining when an earlier tick phase fails, and reports the error', async () => {
    class BrokenSchedules extends JobScheduleRepo {
      readonly failure = new Error('schedules down');

      override async advanceDue(): Promise<never> {
        throw this.failure;
      }
    }
    const resilient = new JobRunner({
      jobs: repo,
      schedules: new BrokenSchedules(t.db, repo),
      handlers: new JobHandlerRegistry([handleJob(echoJob, async () => {})]),
      now,
      random: () => 0,
      workerId: 'test',
    });
    await queue.enqueue(echoJob, { n: 1 });

    const report = await resilient.tick({ budgetMs: 50 * SECOND, maxJobs: 10 });

    expect(report.errors).toEqual([{ phase: TickPhases.advanceDue, message: 'schedules down' }]);
    expect(report.outcomes.succeeded).toBe(1);
  });

  it('retries a throwing handler with backoff and dead-letters it after max_attempts', async () => {
    const { job } = await queue.enqueue(failJob, {}, { maxAttempts: 3 });

    await tick();
    expect(await read(job.id)).toMatchObject({
      status: JobStatuses.queued,
      attempts: 1,
      lastError: 'boom',
      runAt: new Date(T0.getTime() + 30 * SECOND),
    });

    await tick(); // not due yet
    expect(await read(job.id)).toMatchObject({ attempts: 1 });

    advanceClock(30 * SECOND);
    await tick();
    expect(await read(job.id)).toMatchObject({ status: JobStatuses.queued, attempts: 2 });
    expect(await read(job.id)).toMatchObject({ runAt: new Date(clock.now.getTime() + 60 * SECOND) });

    advanceClock(60 * SECOND);
    const report = await tick();
    expect(report.outcomes.dead).toBe(1);
    expect(await read(job.id)).toMatchObject({ status: JobStatuses.dead, attempts: 3, finishedAt: clock.now });
  });

  it('dead-letters a malformed payload immediately, without retries', async () => {
    const { job } = await repo.insert({ kind: echoJob.kind, payload: { n: 'not a number' }, runAt: T0 });

    await tick();

    expect(ran).toEqual([]);
    const row = await read(job.id);
    expect(row).toMatchObject({ status: JobStatuses.dead, attempts: 1 });
    expect(row.lastError).toMatch(/^invalid payload/);
  });

  it('treats an unknown kind as a retryable failure', async () => {
    const { job } = await repo.insert({ kind: 'test.unknown', payload: {}, runAt: T0 });
    await tick();
    expect(await read(job.id)).toMatchObject({ status: JobStatuses.queued, attempts: 1 });
    expect(await read(job.id)).toMatchObject({ lastError: expect.stringMatching(/no handler/) });
  });

  it('stops at its time budget and leaves the rest queued', async () => {
    const ids = await Promise.all(
      Array.from({ length: 5 }, async (_, i) => {
        const { job } = await queue.enqueue(slowJob, {}, { runAt: new Date(T0.getTime() - i) });
        return job.id;
      }),
    );

    const report = await runner.tick({ budgetMs: 50 * SECOND, maxJobs: 100 });

    expect(report.ran).toBe(2);
    const rows = await Promise.all(ids.map(async id => await read(id)));
    const statuses = rows.map(row => row.status);
    expect(statuses.filter(status => status === JobStatuses.succeeded)).toHaveLength(2);
    expect(statuses.filter(status => status === JobStatuses.queued)).toHaveLength(3);
  });

  it('stops at maxJobs', async () => {
    await Promise.all([1, 2, 3].map(async n => await queue.enqueue(echoJob, { n })));
    const report = await runner.tick({ budgetMs: 50 * SECOND, maxJobs: 2 });
    expect(report.ran).toBe(2);
    expect(ran).toHaveLength(2);
  });

  describe('RetryAt', () => {
    it('reschedules at the requested time without spending an attempt', async () => {
      const until = new Date(T0.getTime() + 7 * SECOND);
      const { job } = await queue.enqueue(laterJob, { untilMs: until.getTime() });

      const report = await tick();

      expect(report.outcomes.deferred).toBe(1);
      expect(await read(job.id)).toMatchObject({
        status: JobStatuses.queued,
        runAt: until,
        attempts: 0,
        deferrals: 1,
        lastError: 'rate limited',
      });
    });

    it('never schedules into the past', async () => {
      const { job } = await queue.enqueue(laterJob, { untilMs: T0.getTime() - MINUTE });
      await tick();
      expect(await read(job.id)).toMatchObject({ runAt: T0 });
    });

    it('counts deferrals as attempts past the consecutive cap, then dead-letters', async () => {
      const { job } = await queue.enqueue(laterJob, { untilMs: T0.getTime() }, { maxAttempts: 2 });

      // The first maxConsecutiveDeferrals deferrals are free.
      const free = JobPolicy.maxConsecutiveDeferrals;
      await Array.from({ length: free }).reduce<Promise<unknown>>(async previous => {
        await previous;
        return await tick();
      }, Promise.resolve());
      expect(await read(job.id)).toMatchObject({ attempts: 0, deferrals: free, status: JobStatuses.queued });

      await tick(); // counts: attempt 1 of 2
      expect(await read(job.id)).toMatchObject({ attempts: 1, deferrals: free + 1, status: JobStatuses.queued });

      await tick(); // counts: attempt 2 of 2 → out of attempts
      const row = await read(job.id);
      expect(row).toMatchObject({ attempts: 2, status: JobStatuses.dead });
      expect(row.lastError).toMatch(/RetryAt/);
    });
  });

  it('reclaims a job whose runner crashed and runs it again', async () => {
    const { job } = await queue.enqueue(echoJob, { n: 1 });
    await repo.claim({ now: T0, limit: 1, visibilityMs: MINUTE, workerId: 'crashed' });

    advanceClock(2 * MINUTE);
    const report = await tick();

    expect(report.reclaimed).toBe(1);
    expect(ran).toEqual([{ n: 1, attempt: 2 }]);
    expect(await read(job.id)).toMatchObject({ status: JobStatuses.succeeded });
  });

  it('enqueues and runs due schedules in the same tick', async () => {
    await new JobScheduleRepo(t.db, repo).create({
      kind: echoJob.kind,
      payload: { n: 42 },
      intervalSeconds: 60,
      nextRunAt: T0,
    });

    const report = await tick();

    expect(report.scheduled).toBe(1);
    expect(ran).toEqual([{ n: 42, attempt: 1 }]);
    await tick();
    expect(ran).toHaveLength(1);
  });

  it('ensures the daily jobs.prune schedule and runs it', async () => {
    const withPrune = new JobRunner({
      jobs: repo,
      schedules: new JobScheduleRepo(t.db, repo),
      handlers: new JobHandlerRegistry([createPruneHandler(repo)]),
      now,
      random: () => 0,
      workerId: 'test',
      systemSchedules: [pruneSchedule],
    });

    const report = await withPrune.tick({ budgetMs: 50 * SECOND, maxJobs: 10 });

    expect(report.outcomes.succeeded).toBe(1);
    const [schedule] = await t.db.select().from(jobSchedules);
    expect(schedule).toMatchObject({ kind: 'jobs.prune', intervalSeconds: 86_400 });
  });

  describe('JobQueue.enqueue', () => {
    it('kick runs the job right away through waitUntil', async () => {
      const { job } = await queue.enqueue(echoJob, { n: 3 }, { kick: true });
      await Promise.all(kicked);
      expect(ran).toEqual([{ n: 3, attempt: 1 }]);
      expect(await read(job.id)).toMatchObject({ status: JobStatuses.succeeded });
    });

    it('does not kick a deduped enqueue', async () => {
      await queue.enqueue(echoJob, { n: 1 }, { dedupeKey: 'once' });
      const second = await queue.enqueue(echoJob, { n: 1 }, { dedupeKey: 'once', kick: true });
      expect(second.created).toBe(false);
      expect(kicked).toHaveLength(0);
    });

    it('enqueues inside a caller transaction and rolls back with it', async () => {
      await expect(
        t.db.transaction(async tx => {
          await queue.enqueue(echoJob, { n: 1 }, { executor: tx });
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      expect(await t.db.select().from(jobs)).toHaveLength(0);

      const job = await t.db.transaction(async tx => {
        const result = await queue.enqueue(echoJob, { n: 2 }, { executor: tx });
        return result.job;
      });
      expect(await read(job.id)).toMatchObject({ status: JobStatuses.queued });
    });

    it('refuses kick together with an executor; the caller kicks after commit', async () => {
      await expect(
        t.db.transaction(async tx => await queue.enqueue(echoJob, { n: 1 }, { executor: tx, kick: true })),
      ).rejects.toThrow(/kick/);

      const job = await t.db.transaction(async tx => {
        const result = await queue.enqueue(echoJob, { n: 5 }, { executor: tx });
        return result.job;
      });
      queue.kick(job.id);
      await Promise.all(kicked);
      expect(ran).toEqual([{ n: 5, attempt: 1 }]);
    });

    it('rejects a payload that does not match the job schema', async () => {
      await expect(queue.enqueue(echoJob, { n: 'x' } as unknown as { n: number })).rejects.toThrow();
      expect(await t.db.select().from(jobs)).toHaveLength(0);
    });

    it('runOne returns null for a job that is not claimable', async () => {
      const { job } = await queue.enqueue(echoJob, { n: 1 }, { runAt: new Date(T0.getTime() + MINUTE) });
      expect(await runner.runOne(job.id)).toBeNull();
    });
  });

  it('refuses two handlers for the same kind', () => {
    const handler = handleJob(echoJob, async () => {});
    expect(() => new JobHandlerRegistry([handler, handler])).toThrow(/test.echo/);
  });
});
