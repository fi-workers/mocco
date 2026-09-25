import type { JobDefinition } from '@backend/domain/jobs/handlers';
import type { Job } from '@backend/domain/jobs/repos/job.repo';
import type { Db } from '@backend/infra/db/types';
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
  /** Also run it right away in `waitUntil`; the table stays the durable fallback. Not
   * allowed with `executor`: call `queue.kick(job.id)` after the transaction commits. */
  kick?: boolean;
  /**
   * The caller's transaction, so the job commits or rolls back with the caller's writes.
   * Always pass it when enqueueing inside a transaction: without it the insert asks the
   * pool for a second connection, and production's pool has one (`max: 1`), so it waits
   * on the transaction that is waiting on it — a deadlock.
   */
  executor?: Db;
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
  /** Run an already-enqueued job right away in `waitUntil` (after a transactional enqueue
   * has committed). A job that isn't claimable is left alone. */
  kick(jobId: string): void;
}
