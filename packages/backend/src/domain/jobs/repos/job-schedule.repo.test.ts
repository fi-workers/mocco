import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { nextScheduleRun } from '@backend/domain/jobs/policy';
import { JobScheduleRepo } from '@backend/domain/jobs/repos/job-schedule.repo';
import { JobRepo } from '@backend/domain/jobs/repos/job.repo';
import { jobs, jobSchedules } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

const T0 = new Date('2026-09-25T00:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const MINUTE = 60_000;

describe('JobScheduleRepo (pglite)', () => {
  let t: TestDb;
  let schedules: JobScheduleRepo;

  beforeEach(async () => {
    t = await createTestDb();
    schedules = new JobScheduleRepo(t.db, new JobRepo(t.db));
  });

  afterEach(async () => {
    await t.close();
  });

  const advance = async (now: Date) => await schedules.advanceDue({ now, limit: 10, next: nextScheduleRun });

  it('enqueues one job per due slot and moves next_run_at past now', async () => {
    const schedule = await schedules.create({
      kind: 'test.echo',
      payload: { n: 1 },
      intervalSeconds: 60,
      nextRunAt: T0,
    });

    const enqueued = await advance(at(10_000));

    expect(enqueued).toEqual([expect.objectContaining({ scheduleId: schedule.id, created: true })]);
    const [job] = await t.db.select().from(jobs);
    expect(job).toMatchObject({
      kind: 'test.echo',
      payload: { n: 1 },
      dedupeKey: `${schedule.id}:${T0.toISOString()}`,
    });
    const [row] = await t.db.select().from(jobSchedules).where(eq(jobSchedules.id, schedule.id));
    expect(row).toMatchObject({ nextRunAt: at(MINUTE), lastEnqueuedAt: at(10_000) });
  });

  it('does not double-enqueue a slot when ticks overlap', async () => {
    const schedule = await schedules.create({ kind: 'test.echo', payload: {}, intervalSeconds: 60, nextRunAt: T0 });

    // Two ticks at the same instant, interleaved.
    await Promise.all([advance(at(5000)), advance(at(5000))]);
    // A tick that read the schedule before the first one advanced it: replay the same slot.
    await t.db.update(jobSchedules).set({ nextRunAt: T0 }).where(eq(jobSchedules.id, schedule.id));
    const replay = await advance(at(6000));

    expect(replay).toEqual([expect.objectContaining({ created: false })]);
    expect(await t.db.select().from(jobs)).toHaveLength(1);
  });

  it('ignores schedules that are disabled or not yet due', async () => {
    await schedules.create({ kind: 'test.future', payload: {}, intervalSeconds: 60, nextRunAt: at(MINUTE) });
    const disabled = await schedules.create({ kind: 'test.off', payload: {}, intervalSeconds: 60, nextRunAt: T0 });
    await t.db.update(jobSchedules).set({ enabled: false }).where(eq(jobSchedules.id, disabled.id));

    expect(await advance(T0)).toEqual([]);
  });

  it('disables a cron schedule, since cron expressions are not evaluated yet', async () => {
    const [row] = await t.db
      .insert(jobSchedules)
      .values({ kind: 'test.cron', cron: '0 * * * *', nextRunAt: T0 })
      .returning();
    expect(await advance(T0)).toEqual([]);
    const [after] = await t.db
      .select()
      .from(jobSchedules)
      .where(eq(jobSchedules.id, row?.id ?? ''));
    expect(after?.enabled).toBe(false);
    expect(await t.db.select().from(jobs)).toHaveLength(0);
  });

  it('ensureSystem creates a platform schedule once per kind', async () => {
    await schedules.ensureSystem({ kind: 'jobs.prune', payload: {}, intervalSeconds: 86_400 }, T0);
    await schedules.ensureSystem({ kind: 'jobs.prune', payload: {}, intervalSeconds: 86_400 }, at(MINUTE));
    const rows = await t.db.select().from(jobSchedules);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'jobs.prune', workspaceId: null, nextRunAt: T0 });
  });

  it('ensureSystem updates the interval of an existing platform schedule', async () => {
    await schedules.ensureSystem({ kind: 'jobs.prune', payload: {}, intervalSeconds: 86_400 }, T0);
    await schedules.ensureSystem({ kind: 'jobs.prune', payload: {}, intervalSeconds: 3600 }, at(MINUTE));
    const rows = await t.db.select().from(jobSchedules);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ intervalSeconds: 3600, nextRunAt: T0 });
  });

  it('rejects a schedule with neither cron nor interval at the DB', async () => {
    await expect(t.db.insert(jobSchedules).values({ kind: 'test.bad', nextRunAt: T0 })).rejects.toThrow();
  });
});
