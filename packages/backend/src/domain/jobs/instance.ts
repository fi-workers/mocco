// Production composition root for the jobs domain (ADR 0014). Lazy so builds don't
// need env at import. No external dependency — always available. Each domain that
// runs background work exports its handlers; they are registered here.
import { randomUUID } from 'node:crypto';

import { waitUntil } from '@vercel/functions';

import { JobHandlerRegistry, type JobHandler } from '@backend/domain/jobs/handlers';
import { JobRunner } from '@backend/domain/jobs/JobRunner';
import { PostgresJobQueue } from '@backend/domain/jobs/PostgresJobQueue';
import { createPruneHandler, pruneSchedule } from '@backend/domain/jobs/prune';
import { JobScheduleRepo } from '@backend/domain/jobs/repos/job-schedule.repo';
import { JobRepo } from '@backend/domain/jobs/repos/job.repo';
import { getDb } from '@backend/infra/db/client';

import type { JobQueue } from '@backend/domain/jobs/ports';
import type { Db } from '@backend/infra/db/types';

/** Upper bound on jobs one tick runs; the time budget (JOBS_TICK_BUDGET_MS) usually stops it first. */
export const DEFAULT_TICK_MAX_JOBS = 100;

export interface Jobs {
  queue: JobQueue;
  runner: JobRunner;
}

export interface JobsDeps {
  now: () => Date;
  random: () => number;
  waitUntil: (promise: Promise<unknown>) => void;
  workerId: string;
}

/** Build the jobs domain over a db. The production root below binds it once; tests
 * construct the same classes over pglite with a fake clock. */
export function createJobs(db: Db, deps: JobsDeps): Jobs {
  const jobs = new JobRepo(db);
  const handlers: JobHandler[] = [createPruneHandler(jobs)];
  const runner = new JobRunner({
    jobs,
    schedules: new JobScheduleRepo(db, jobs),
    handlers: new JobHandlerRegistry(handlers),
    now: deps.now,
    random: deps.random,
    workerId: deps.workerId,
    systemSchedules: [pruneSchedule],
  });
  const queue = new PostgresJobQueue({
    jobs,
    now: deps.now,
    runOne: async id => await runner.runOne(id),
    waitUntil: deps.waitUntil,
  });
  return { queue, runner };
}

const state: { jobs?: Jobs } = {};

/** The job queue and runner. Always available (no external dependency to gate on). */
export function getJobs(): Jobs {
  state.jobs ??= createJobs(getDb(), {
    now: () => new Date(),
    random: Math.random,
    waitUntil,
    workerId: `fn-${randomUUID().slice(0, 8)}`,
  });
  return state.jobs;
}
