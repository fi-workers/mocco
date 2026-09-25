// Top-level composition root for the job runner (ADR 0014). It sits above the domains,
// like transport: it imports each domain's pure handler factory (`domain/<x>/jobs.ts`,
// which never imports its own instance.ts) and builds one registry. Domains that only
// enqueue use `getJobQueue()` from domain/jobs/instance.ts, which reaches this module
// lazily (dynamic import) for `kick`, so no instance.ts ever imports another domain's
// instance.ts through the job registry.
import { randomUUID } from 'node:crypto';

import { JobHandlerRegistry, type JobHandler } from '@backend/domain/jobs/handlers';
import { JobRunner } from '@backend/domain/jobs/JobRunner';
import { createPruneHandlers, pruneSchedule } from '@backend/domain/jobs/prune';
import { JobScheduleRepo } from '@backend/domain/jobs/repos/job-schedule.repo';
import { JobRepo } from '@backend/domain/jobs/repos/job.repo';
import { getDb } from '@backend/infra/db/client';

import type { Db } from '@backend/infra/db/types';

/** Upper bound on jobs one tick runs; the time budget usually stops it first. */
export const DEFAULT_TICK_MAX_JOBS = 100;

export interface JobRunnerRuntimeDeps {
  now: () => Date;
  random: () => number;
  workerId: string;
}

/** Build the runner with every domain's handlers over a db. Production binds it once
 * below; tests call it with a pglite db and a fake clock. */
export function createJobRunner(db: Db, deps: JobRunnerRuntimeDeps): JobRunner {
  const jobs = new JobRepo(db);
  // Add each domain's handler factory here: `...createXHandlers({ …repos/services })`.
  const handlers: JobHandler[] = [...createPruneHandlers(jobs)];
  return new JobRunner({
    jobs,
    schedules: new JobScheduleRepo(db, jobs),
    handlers: new JobHandlerRegistry(handlers),
    now: deps.now,
    random: deps.random,
    workerId: deps.workerId,
    systemSchedules: [pruneSchedule],
  });
}

const state: { runner?: JobRunner } = {};

/** The production job runner (lazy). Used by the tick route and by `kick`. */
export function getJobRunner(): JobRunner {
  state.runner ??= createJobRunner(getDb(), {
    now: () => new Date(),
    random: Math.random,
    workerId: `fn-${randomUUID().slice(0, 8)}`,
  });
  return state.runner;
}
