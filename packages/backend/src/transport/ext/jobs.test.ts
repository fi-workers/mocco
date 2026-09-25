import { JobStatuses } from '@mocco/common/jobs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineJob, handleJob, JobHandlerRegistry } from '@backend/domain/jobs/handlers';
import { JobRunner } from '@backend/domain/jobs/JobRunner';
import { JobScheduleRepo } from '@backend/domain/jobs/repos/job-schedule.repo';
import { JobRepo } from '@backend/domain/jobs/repos/job.repo';
import { jobs } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { createJobTickRoutes, JOB_TICK_PATH, type JobTickDeps } from '@backend/transport/ext/jobs';

const T0 = new Date('2026-09-25T00:00:00.000Z');
const echoJob = defineJob('test.echo', z.object({}));

async function call(deps: JobTickDeps | undefined, init: RequestInit = {}) {
  return await createJobTickRoutes(deps).fetch(new Request(`https://local.test${JOB_TICK_PATH}`, init));
}

describe('job tick route (pglite)', () => {
  let t: TestDb;
  let repo: JobRepo;
  let runner: JobRunner;

  beforeEach(async () => {
    t = await createTestDb();
    repo = new JobRepo(t.db);
    runner = new JobRunner({
      jobs: repo,
      schedules: new JobScheduleRepo(t.db, repo),
      handlers: new JobHandlerRegistry([handleJob(echoJob, async () => {})]),
      now: () => T0,
      random: () => 0,
      workerId: 'test',
    });
  });

  afterEach(async () => {
    await t.close();
  });

  const tickDeps = (secrets: string[]): JobTickDeps => ({ runner, secrets, budgetMs: 10_000, maxJobs: 10 });

  it('503s when no tick secret is configured', async () => {
    expect(await call(undefined)).toMatchObject({ status: 503 });
    expect(await call(tickDeps([]), { headers: { authorization: 'Bearer ' } })).toMatchObject({ status: 503 });
  });

  it('401s without the bearer secret, or with a wrong one, and runs nothing', async () => {
    await repo.insert({ kind: echoJob.kind, payload: {}, runAt: T0 });
    const deps = tickDeps(['cron-secret']);

    expect(await call(deps)).toMatchObject({ status: 401 });
    expect(await call(deps, { headers: { authorization: 'Bearer wrong' } })).toMatchObject({ status: 401 });
    expect(await call(deps, { headers: { authorization: 'cron-secret' } })).toMatchObject({ status: 401 });

    const [row] = await t.db.select().from(jobs);
    expect(row?.status).toBe(JobStatuses.queued);
  });

  it('runs a tick on GET (what Vercel Cron sends) and reports it', async () => {
    await repo.insert({ kind: echoJob.kind, payload: {}, runAt: T0 });

    const res = await call(tickDeps(['cron-secret']), { headers: { authorization: 'Bearer cron-secret' } });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ran: 1, outcomes: { succeeded: 1 } });
    const [row] = await t.db.select().from(jobs);
    expect(row?.status).toBe(JobStatuses.succeeded);
  });

  it('accepts POST and either configured secret', async () => {
    const deps = tickDeps(['cron-secret', 'self-host-secret']);
    const res = await call(deps, { method: 'POST', headers: { authorization: 'Bearer self-host-secret' } });
    expect(res.status).toBe(200);
  });
});
