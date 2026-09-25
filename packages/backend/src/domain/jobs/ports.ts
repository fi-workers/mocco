import type { JobDefinition } from '@backend/domain/jobs/handlers';
import type { Job } from '@backend/domain/jobs/repos/job.repo';
import type { z } from 'zod';

export interface EnqueueOptions {
  /** Earliest run time; defaults to now. */
  runAt?: Date;
  /** While a job with the same (kind, dedupeKey) is queued or running, enqueue returns it
   * instead of inserting another. */
  dedupeKey?: string;
  /** Defaults to `JobPolicy.defaultMaxAttempts` (8). */
  maxAttempts?: number;
  /** Tenant the job belongs to; the job is deleted with the workspace. */
  workspaceId?: string;
  /** Also run it right away in `waitUntil`; the table stays the durable fallback. */
  kick?: boolean;
}

export interface EnqueueResult {
  job: Job;
  /** false when a live job with the same dedupe key already existed (that job is returned). */
  created: boolean;
}

/** The neutral enqueue surface domains depend on. Today it is Postgres
 * (`PostgresJobQueue`); a hosted-queue driver can replace it without touching handlers. */
export interface JobQueue {
  enqueue<S extends z.ZodType>(
    job: JobDefinition<S>,
    payload: z.input<S>,
    options?: EnqueueOptions,
  ): Promise<EnqueueResult>;
}
