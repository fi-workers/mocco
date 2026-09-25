import { JobStatuses } from '@mocco/common/jobs';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { JobRepo } from '@backend/domain/jobs/repos/job.repo';
import { jobs } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

const T0 = new Date('2026-09-25T00:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

describe('JobRepo (pglite)', () => {
  let t: TestDb;
  let repo: JobRepo;

  beforeEach(async () => {
    t = await createTestDb();
    repo = new JobRepo(t.db);
  });

  afterEach(async () => {
    await t.close();
  });

  const read = async (id: string) => {
    const [row] = await t.db.select().from(jobs).where(eq(jobs.id, id));
    return row;
  };
  const enqueue = async (overrides: Partial<Parameters<JobRepo['insert']>[0]> = {}) => {
    const { job } = await repo.insert({ kind: 'test.echo', payload: { n: 1 }, runAt: T0, ...overrides });
    return job;
  };
  const claimOne = async (now = T0) => {
    const [job] = await repo.claim({ now, limit: 1, visibilityMs: 5 * MINUTE, workerId: 'w1' });
    if (!job) {
      throw new Error('expected a claim');
    }
    return job;
  };

  describe('insert', () => {
    it('creates a queued job with the defaults', async () => {
      const { job, created } = await repo.insert({ kind: 'test.echo', payload: { n: 1 }, runAt: T0 });
      expect(created).toBe(true);
      expect(job).toMatchObject({ status: JobStatuses.queued, attempts: 0, maxAttempts: 8, deferrals: 0 });
    });

    it('returns the live job instead of inserting a duplicate dedupe key', async () => {
      const first = await repo.insert({ kind: 'test.echo', payload: {}, runAt: T0, dedupeKey: 'k1' });
      const second = await repo.insert({ kind: 'test.echo', payload: {}, runAt: T0, dedupeKey: 'k1' });
      expect(second.created).toBe(false);
      expect(second.job.id).toBe(first.job.id);
      expect(await t.db.select().from(jobs)).toHaveLength(1);
    });

    it('scopes the dedupe key per kind', async () => {
      await repo.insert({ kind: 'test.a', payload: {}, runAt: T0, dedupeKey: 'k1' });
      const other = await repo.insert({ kind: 'test.b', payload: {}, runAt: T0, dedupeKey: 'k1' });
      expect(other.created).toBe(true);
    });

    it('allows the same dedupe key again once the earlier job finished', async () => {
      const first = await enqueue({ dedupeKey: 'k1' });
      const claimed = await claimOne();
      expect(claimed.id).toBe(first.id);
      await repo.complete(claimed, T0);
      const again = await repo.insert({ kind: 'test.echo', payload: {}, runAt: T0, dedupeKey: 'k1' });
      expect(again.created).toBe(true);
      expect(again.job.id).not.toBe(first.id);
    });
  });

  describe('claim', () => {
    it('claims due jobs oldest first, marks them running and counts the attempt', async () => {
      const later = await enqueue({ runAt: at(-MINUTE) });
      const older = await enqueue({ runAt: at(-2 * MINUTE) });
      await enqueue({ runAt: at(MINUTE) }); // not due yet

      const claimed = await repo.claim({ now: T0, limit: 10, visibilityMs: 5 * MINUTE, workerId: 'w1' });

      const running = { status: JobStatuses.running, attempts: 1, lockedUntil: at(5 * MINUTE) };
      expect(new Set(claimed.map(job => job.id))).toEqual(new Set([later.id, older.id]));
      expect(claimed).toEqual([
        expect.objectContaining({ ...running, lockedBy: expect.stringMatching(/^w1\//) }),
        expect.objectContaining({ ...running, lockedBy: expect.stringMatching(/^w1\//) }),
      ]);
      const [first] = await repo.claim({ now: at(2 * MINUTE), limit: 1, visibilityMs: MINUTE, workerId: 'w1' });
      expect(first?.runAt).toEqual(at(MINUTE));
    });

    it('never hands the same job to two interleaved claims', async () => {
      const created = await Promise.all(Array.from({ length: 12 }, async () => await enqueue()));
      const ids = created.map(job => job.id);

      // pglite is one connection, so these claim transactions interleave by queueing
      // rather than truly racing; the real row-lock race is FOR UPDATE SKIP LOCKED on Postgres.
      const batches = await Promise.all(
        Array.from(
          { length: 4 },
          async (_, i) => await repo.claim({ now: T0, limit: 5, visibilityMs: MINUTE, workerId: `w${i}` }),
        ),
      );

      const claimedIds = batches.flat().map(job => job.id);
      expect(new Set(claimedIds).size).toBe(claimedIds.length);
      expect(new Set(claimedIds)).toEqual(new Set(ids));
    });

    it('claims one specific job by id', async () => {
      await enqueue();
      const target = await enqueue();
      const claimed = await repo.claim({ now: T0, limit: 1, visibilityMs: MINUTE, workerId: 'w1', id: target.id });
      expect(claimed.map(job => job.id)).toEqual([target.id]);
      expect(await repo.claim({ now: T0, limit: 1, visibilityMs: MINUTE, workerId: 'w2', id: target.id })).toEqual([]);
    });
  });

  describe('post-claim writes', () => {
    it('complete marks the job succeeded', async () => {
      await enqueue();
      const job = await claimOne();
      expect(await repo.complete(job, at(1000))).toBe(true);
      expect(await read(job.id)).toMatchObject({
        status: JobStatuses.succeeded,
        finishedAt: at(1000),
        lockedUntil: null,
      });
    });

    it('ignores a write from a runner that lost its lock', async () => {
      await enqueue();
      const stale = await claimOne();
      await repo.reclaimExpired(at(10 * MINUTE));
      const fresh = await claimOne(at(10 * MINUTE));
      expect(await repo.complete(stale, at(11 * MINUTE))).toBe(false);
      expect(await read(fresh.id)).toMatchObject({ status: JobStatuses.running, attempts: 2 });
    });

    it('fail with a retry time re-queues the job and records the error', async () => {
      await enqueue();
      const job = await claimOne();
      await repo.fail(job, { now: T0, error: 'boom', retryAt: at(30_000) });
      expect(await read(job.id)).toMatchObject({
        status: JobStatuses.queued,
        runAt: at(30_000),
        attempts: 1,
        lastError: 'boom',
        lockedUntil: null,
      });
    });

    it('fail without a retry time dead-letters the job', async () => {
      await enqueue();
      const job = await claimOne();
      await repo.fail(job, { now: T0, error: 'bad payload', retryAt: null });
      expect(await read(job.id)).toMatchObject({ status: JobStatuses.dead, finishedAt: T0, lastError: 'bad payload' });
    });

    it('defer reschedules at the requested time and can refund the attempt', async () => {
      await enqueue();
      const job = await claimOne();
      await repo.defer(job, { runAt: at(MINUTE), reason: 'rate limited', refundAttempt: true, countsDeferral: true });
      expect(await read(job.id)).toMatchObject({
        status: JobStatuses.queued,
        runAt: at(MINUTE),
        attempts: 0,
        deferrals: 1,
        lastError: 'rate limited',
      });
      const again = await claimOne(at(MINUTE));
      await repo.defer(again, {
        runAt: at(2 * MINUTE),
        reason: 'still limited',
        refundAttempt: false,
        countsDeferral: true,
      });
      expect(await read(job.id)).toMatchObject({ attempts: 1, deferrals: 2 });
    });

    it('a regular failure resets the consecutive deferral count', async () => {
      await enqueue();
      const job = await claimOne();
      await repo.defer(job, { runAt: T0, reason: 'later', refundAttempt: true, countsDeferral: true });
      await repo.fail(await claimOne(), { now: T0, error: 'boom', retryAt: T0 });
      expect(await read(job.id)).toMatchObject({ deferrals: 0 });
    });
  });

  describe('reclaimExpired', () => {
    it('re-queues running jobs whose lock expired and leaves live locks alone', async () => {
      const expired = await enqueue();
      await repo.claim({ now: T0, limit: 1, visibilityMs: MINUTE, workerId: 'w1', id: expired.id });
      const live = await enqueue();
      await repo.claim({ now: T0, limit: 1, visibilityMs: 10 * MINUTE, workerId: 'w1', id: live.id });

      expect(await repo.reclaimExpired(at(2 * MINUTE))).toBe(1);

      expect(await read(expired.id)).toMatchObject({ status: JobStatuses.queued, attempts: 1, lockedUntil: null });
      expect(await read(live.id)).toMatchObject({ status: JobStatuses.running });
    });

    it('resets the consecutive deferral count of a reclaimed job', async () => {
      await enqueue();
      await repo.defer(await claimOne(), { runAt: T0, reason: 'later', refundAttempt: true, countsDeferral: true });
      await repo.claim({ now: T0, limit: 1, visibilityMs: MINUTE, workerId: 'w1' });
      await repo.reclaimExpired(at(2 * MINUTE));
      const [row] = await t.db.select().from(jobs);
      expect(row).toMatchObject({ status: JobStatuses.queued, deferrals: 0 });
    });

    it('dead-letters an expired job that has no attempts left', async () => {
      const job = await enqueue({ maxAttempts: 1 });
      await repo.claim({ now: T0, limit: 1, visibilityMs: MINUTE, workerId: 'w1', id: job.id });
      expect(await repo.reclaimExpired(at(2 * MINUTE))).toBe(1);
      expect(await read(job.id)).toMatchObject({ status: JobStatuses.dead, finishedAt: at(2 * MINUTE) });
    });
  });

  it('indexes workspace_id on both job tables', async () => {
    const result = await t.db.execute<{ indexname: string }>(
      sql`SELECT indexname FROM pg_indexes WHERE tablename IN ('mocco_jobs', 'mocco_job_schedules')`,
    );
    const names = result.rows.map(row => row.indexname);
    expect(names).toEqual(expect.arrayContaining(['mocco_jobs_workspace_idx', 'mocco_job_schedules_workspace_idx']));
  });

  describe('prune', () => {
    it('deletes succeeded jobs after 7 days and dead jobs after 30 days', async () => {
      const finish = async (status: 'succeeded' | 'dead', finishedAt: Date) => {
        const job = await enqueue();
        await t.db.update(jobs).set({ status, finishedAt }).where(eq(jobs.id, job.id));
        return job.id;
      };
      const oldSucceeded = await finish(JobStatuses.succeeded, at(-8 * DAY));
      const recentSucceeded = await finish(JobStatuses.succeeded, at(-6 * DAY));
      const oldDead = await finish(JobStatuses.dead, at(-31 * DAY));
      const recentDead = await finish(JobStatuses.dead, at(-8 * DAY));
      const { id: queued } = await enqueue({ runAt: at(-60 * DAY) });

      expect(await repo.prune(T0)).toBe(2);

      const rows = await t.db.select({ id: jobs.id }).from(jobs);
      const left = rows.map(row => row.id);
      expect(new Set(left)).toEqual(new Set([recentSucceeded, recentDead, queued]));
      expect(left).not.toContain(oldSucceeded);
      expect(left).not.toContain(oldDead);
    });
  });
});
