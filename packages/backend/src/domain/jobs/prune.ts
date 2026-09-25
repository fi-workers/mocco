import { z } from 'zod';

import { defineJob, handleJob } from '@backend/domain/jobs/handlers';

import type { SystemSchedule } from '@backend/domain/jobs/repos/job-schedule.repo';
import type { JobRepo } from '@backend/domain/jobs/repos/job.repo';

/** The job domain's own kinds. */
export const JobKinds = {
  prune: 'jobs.prune',
} as const;

/** Deletes succeeded jobs after 7 days and dead jobs after 30 (`JobPolicy`). */
export const pruneJobs = defineJob(JobKinds.prune, z.object({}));

export function createPruneHandler(jobs: JobRepo) {
  return handleJob(pruneJobs, async (_payload, ctx) => {
    await jobs.prune(ctx.now());
  });
}

/** Daily, as a platform schedule ensured by every tick. */
export const pruneSchedule: SystemSchedule = { kind: JobKinds.prune, payload: {}, intervalSeconds: 24 * 60 * 60 };
