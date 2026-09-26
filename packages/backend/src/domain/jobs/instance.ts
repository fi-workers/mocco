// Production composition root for enqueueing (ADR 0014). Lazy so builds don't need env
// at import. Domains inject `getJobQueue()` into their services to enqueue work. It
// depends only on the DB and the queue: the runner (and with it every domain's handlers)
// is bound lazily through a dynamic import of runtime/jobs.ts when a job is kicked, so
// importing this file never pulls in another domain's instance.ts.
import { waitUntil } from '@vercel/functions';

import { PostgresJobQueue } from '@backend/domain/jobs/PostgresJobQueue';
import { JobRepo } from '@backend/domain/jobs/repos/job.repo';
import { getDb } from '@backend/infra/db/client';

import type { JobQueue } from '@backend/domain/jobs/ports';

const state: { queue?: JobQueue } = {};

/** The job queue. Always available (no external dependency to gate on). */
export function getJobQueue(): JobQueue {
  state.queue ??= new PostgresJobQueue({
    jobs: new JobRepo(getDb()),
    now: () => new Date(),
    runOne: async id => {
      const { getJobRunner } = await import('@backend/runtime/jobs');
      return await getJobRunner().runOne(id);
    },
    waitUntil,
  });
  return state.queue;
}
