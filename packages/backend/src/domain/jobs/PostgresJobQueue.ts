import { JobPolicy } from '@backend/domain/jobs/policy';

import type { JobDefinition } from '@backend/domain/jobs/handlers';
import type { EnqueueOptions, EnqueueResult, JobQueue } from '@backend/domain/jobs/ports';
import type { JobRepo } from '@backend/domain/jobs/repos/job.repo';
import type { z } from 'zod';

export interface PostgresJobQueueDeps {
  jobs: JobRepo;
  now: () => Date;
  /** Runs a job right away (`JobRunner.runOne`), for `kick`. */
  runOne: (id: string) => Promise<unknown>;
  /** Keeps the kicked run alive after the response (prod: `@vercel/functions` waitUntil). */
  waitUntil: (promise: Promise<unknown>) => void;
}

/** `JobQueue` over mocco_jobs. */
export class PostgresJobQueue implements JobQueue {
  constructor(private readonly deps: PostgresJobQueueDeps) {}

  /** Validate the payload against the job's schema (a mismatch is a programming error
   * and throws), insert the job (deduped), and optionally kick it. */
  async enqueue<S extends z.ZodType>(
    job: JobDefinition<S>,
    payload: z.input<S>,
    options: EnqueueOptions = {},
  ): Promise<EnqueueResult> {
    const result = await this.deps.jobs.insert({
      kind: job.kind,
      payload: job.payload.parse(payload),
      runAt: options.runAt ?? this.deps.now(),
      workspaceId: options.workspaceId ?? null,
      maxAttempts: options.maxAttempts ?? JobPolicy.defaultMaxAttempts,
      dedupeKey: options.dedupeKey ?? null,
    });
    if (options.kick === true && result.created) {
      const { id } = result.job;
      this.deps.waitUntil(
        (async () => {
          try {
            await this.deps.runOne(id);
          } catch (error) {
            // The row is still queued (or will be reclaimed); the next tick runs it.
            console.error('[jobs] kicked run failed', error);
          }
        })(),
      );
    }
    return result;
  }
}
