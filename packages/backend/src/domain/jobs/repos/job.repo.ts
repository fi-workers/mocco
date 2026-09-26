import { randomUUID } from 'node:crypto';

import { JobStatuses } from '@mocco/common/jobs';
import { and, asc, eq, gte, inArray, lt, lte, notInArray, or, sql } from 'drizzle-orm';

import { JobPolicy } from '@backend/domain/jobs/policy';
import { expectOne } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';

const { jobs } = schema;

export type Job = typeof jobs.$inferSelect;
export type NewJob = Pick<
  typeof jobs.$inferInsert,
  'kind' | 'payload' | 'runAt' | 'workspaceId' | 'maxAttempts' | 'dedupeKey'
>;
/** The claimed row a post-claim write is guarded by (its lock token in `lockedBy`). */
type Claimed = Pick<Job, 'id' | 'lockedBy'>;

export interface ClaimOptions {
  now: Date;
  limit: number;
  visibilityMs: number;
  /** Prefix of the lock token, for debugging which runner holds a row. */
  workerId: string;
  /** Claim only this job (the `kick` path). */
  id?: string;
  /** Skip these jobs — a tick never runs the same job twice (e.g. one it just re-queued for now). */
  excludeIds?: readonly string[];
}

/** How long finished jobs are kept before `prune` deletes them. */
export interface JobRetention {
  succeededMs: number;
  deadMs: number;
}
const DEFAULT_RETENTION: JobRetention = {
  succeededMs: JobPolicy.succeededRetentionMs,
  deadMs: JobPolicy.deadRetentionMs,
};

/** The predicate of `mocco_jobs_kind_dedupe_key_uq`, repeated as the ON CONFLICT arbiter. */
const liveDedupe = sql.raw(`dedupe_key IS NOT NULL AND status IN ('${JobStatuses.queued}','${JobStatuses.running}')`);
/** A live dedupe holder can finish between our conflict and our lookup; retry the insert then. */
const MAX_DEDUPE_RETRIES = 3;

/** Data access for mocco_jobs (ADR 0012, ADR 0014). The repo owns the claim transaction;
 * the runner decides outcomes and passes plain values in. Jobs are platform-scoped
 * (a runner drains every workspace's jobs), so queries are not workspace-filtered. */
export class JobRepo {
  constructor(private readonly db: Db) {}

  /** Every post-claim write: only while the row is still running under this claim's token. */
  private async writeClaimed(job: Claimed, values: PgUpdateSetSource<typeof jobs>): Promise<boolean> {
    if (job.lockedBy === null) {
      return false;
    }
    const updated = await this.db
      .update(jobs)
      .set(values)
      .where(and(eq(jobs.id, job.id), eq(jobs.status, JobStatuses.running), eq(jobs.lockedBy, job.lockedBy)))
      .returning({ id: jobs.id });
    return updated.length > 0;
  }

  /**
   * Insert a job. With a `dedupeKey`, a live (queued/running) job of the same kind and
   * key wins: nothing is inserted and that job is returned with `created: false`.
   * `executor` lets the schedule repo insert inside its own transaction.
   */
  async insert(
    values: NewJob,
    executor: Db = this.db,
    retries = MAX_DEDUPE_RETRIES,
  ): Promise<{ job: Job; created: boolean }> {
    if (values.dedupeKey == null) {
      return { job: expectOne(await executor.insert(jobs).values(values).returning()), created: true };
    }
    const [inserted] = await executor
      .insert(jobs)
      .values(values)
      .onConflictDoNothing({ target: [jobs.kind, jobs.dedupeKey], where: liveDedupe })
      .returning();
    if (inserted) {
      return { job: inserted, created: true };
    }
    const [existing] = await executor
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.kind, values.kind),
          eq(jobs.dedupeKey, values.dedupeKey),
          inArray(jobs.status, [JobStatuses.queued, JobStatuses.running]),
        ),
      );
    if (existing) {
      return { job: existing, created: false };
    }
    if (retries <= 0) {
      throw new Error(`could not insert or find job ${values.kind}:${values.dedupeKey}`);
    }
    return await this.insert(values, executor, retries - 1);
  }

  async findById(id: string): Promise<Job | undefined> {
    const [row] = await this.db.select().from(jobs).where(eq(jobs.id, id));
    return row;
  }

  /**
   * Claim up to `limit` due jobs in one transaction: `SELECT … FOR UPDATE SKIP LOCKED`
   * picks rows no other transaction holds, then the UPDATE marks them running with a
   * fresh lock token, `locked_until = now + visibility` and `attempts + 1`. Row locks are
   * transaction-scoped, so this is safe on the transaction pooler.
   */
  async claim(options: ClaimOptions): Promise<Job[]> {
    const { now, limit, visibilityMs, workerId, id, excludeIds = [] } = options;
    return await this.db.transaction(async tx => {
      const due = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.status, JobStatuses.queued),
            lte(jobs.runAt, now),
            id === undefined ? undefined : eq(jobs.id, id),
            excludeIds.length === 0 ? undefined : notInArray(jobs.id, [...excludeIds]),
          ),
        )
        .orderBy(asc(jobs.runAt))
        .limit(limit)
        .for('update', { skipLocked: true });
      if (due.length === 0) {
        return [];
      }
      return await tx
        .update(jobs)
        .set({
          status: JobStatuses.running,
          lockedUntil: new Date(now.getTime() + visibilityMs),
          lockedBy: `${workerId}/${randomUUID()}`,
          attempts: sql`${jobs.attempts} + 1`,
        })
        .where(
          inArray(
            jobs.id,
            due.map(row => row.id),
          ),
        )
        .returning();
    });
  }

  /** Mark a claimed job succeeded. false when the claim was lost (reclaimed meanwhile). */
  async complete(job: Claimed, now: Date): Promise<boolean> {
    return await this.writeClaimed(job, {
      status: JobStatuses.succeeded,
      finishedAt: now,
      lockedUntil: null,
      deferrals: 0,
    });
  }

  /** A failed attempt: re-queue at `retryAt`, or dead-letter when `retryAt` is null. */
  async fail(job: Claimed, outcome: { now: Date; error: string; retryAt: Date | null }): Promise<boolean> {
    const { now, error, retryAt } = outcome;
    return await this.writeClaimed(
      job,
      retryAt === null
        ? { status: JobStatuses.dead, finishedAt: now, lockedUntil: null, lastError: error, deferrals: 0 }
        : { status: JobStatuses.queued, runAt: retryAt, lockedUntil: null, lastError: error, deferrals: 0 },
    );
  }

  /** A RetryAt: re-queue at `runAt`, bump the consecutive deferral count and, when
   * `refundAttempt`, give back the attempt the claim counted. */
  async defer(
    job: Claimed,
    outcome: { runAt: Date; reason: string; refundAttempt: boolean; countsDeferral: boolean },
  ): Promise<boolean> {
    return await this.writeClaimed(job, {
      status: JobStatuses.queued,
      runAt: outcome.runAt,
      lockedUntil: null,
      lastError: outcome.reason,
      deferrals: outcome.countsDeferral ? sql`${jobs.deferrals} + 1` : undefined,
      attempts: outcome.refundAttempt ? sql`${jobs.attempts} - 1` : undefined,
    });
  }

  /**
   * Recover runs whose runner died: a running job past `locked_until` goes back to
   * queued (the crashed attempt stays counted, the RetryAt streak resets), or dead when
   * it has no attempts left.
   * Returns the number of rows recovered.
   */
  async reclaimExpired(now: Date): Promise<number> {
    const expired = and(eq(jobs.status, JobStatuses.running), lt(jobs.lockedUntil, now));
    const lastError = 'lock expired before the run finished';
    return await this.db.transaction(async tx => {
      const dead = await tx
        .update(jobs)
        .set({ status: JobStatuses.dead, finishedAt: now, lockedUntil: null, lastError, deferrals: 0 })
        .where(and(expired, gte(jobs.attempts, jobs.maxAttempts)))
        .returning({ id: jobs.id });
      const requeued = await tx
        .update(jobs)
        .set({ status: JobStatuses.queued, runAt: now, lockedUntil: null, lastError, deferrals: 0 })
        .where(expired)
        .returning({ id: jobs.id });
      return dead.length + requeued.length;
    });
  }

  /** Delete finished jobs past retention (default: succeeded after 7 days, dead after 30).
   * Returns the number of rows deleted. */
  async prune(now: Date, retention: JobRetention = DEFAULT_RETENTION): Promise<number> {
    const deleted = await this.db
      .delete(jobs)
      .where(
        or(
          and(
            eq(jobs.status, JobStatuses.succeeded),
            lt(jobs.finishedAt, new Date(now.getTime() - retention.succeededMs)),
          ),
          and(eq(jobs.status, JobStatuses.dead), lt(jobs.finishedAt, new Date(now.getTime() - retention.deadMs))),
        ),
      )
      .returning({ id: jobs.id });
    return deleted.length;
  }
}
