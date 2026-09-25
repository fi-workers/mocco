import { and, asc, eq, lte, sql } from 'drizzle-orm';

import { expectOne } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { JobRepo } from '@backend/domain/jobs/repos/job.repo';
import type { Db } from '@backend/infra/db/types';

const { jobSchedules } = schema;

export type JobSchedule = typeof jobSchedules.$inferSelect;
/** Interval schedules only: cron expressions are reserved in the schema but not evaluated yet. */
export type NewJobSchedule = Pick<
  typeof jobSchedules.$inferInsert,
  'kind' | 'payload' | 'workspaceId' | 'projectId'
> & {
  intervalSeconds: number;
  nextRunAt: Date;
};
/** A platform schedule (no workspace), at most one per kind. */
export interface SystemSchedule {
  kind: string;
  payload: unknown;
  intervalSeconds: number;
}

export interface ScheduledJob {
  scheduleId: string;
  jobId: string;
  /** false when the slot's job already existed (an overlapping tick got there first). */
  created: boolean;
}

/** Data access for mocco_job_schedules (ADR 0012, ADR 0014). Advancing a schedule and
 * inserting its slot's job happen in one transaction, through `JobRepo.insert`. */
export class JobScheduleRepo {
  constructor(
    private readonly db: Db,
    private readonly jobs: JobRepo,
  ) {}

  async create(values: NewJobSchedule): Promise<JobSchedule> {
    return expectOne(await this.db.insert(jobSchedules).values(values).returning());
  }

  /** Create the platform schedule for `kind` if it doesn't exist; first run at `now`. */
  async ensureSystem(schedule: SystemSchedule, now: Date): Promise<void> {
    await this.db
      .insert(jobSchedules)
      .values({ ...schedule, workspaceId: null, nextRunAt: now })
      .onConflictDoNothing({ target: jobSchedules.kind, where: sql.raw('workspace_id IS NULL') });
  }

  /**
   * Enqueue the current slot of every due, enabled schedule and move it to its next slot.
   * `FOR UPDATE SKIP LOCKED` keeps two overlapping ticks off the same schedule, and the
   * job's `dedupe_key = <scheduleId>:<slot ISO>` makes a replayed slot a no-op even if a
   * tick read the schedule before another one advanced it. A schedule whose next run
   * can't be computed (`next` returns null, e.g. a cron row) is disabled instead.
   */
  async advanceDue(options: {
    now: Date;
    limit: number;
    next: (schedule: JobSchedule, now: Date) => Date | null;
  }): Promise<ScheduledJob[]> {
    const { now, limit, next } = options;
    return await this.db.transaction(async tx => {
      const due = await tx
        .select()
        .from(jobSchedules)
        .where(and(eq(jobSchedules.enabled, true), lte(jobSchedules.nextRunAt, now)))
        .orderBy(asc(jobSchedules.nextRunAt))
        .limit(limit)
        .for('update', { skipLocked: true });
      const results = await Promise.all(
        due.map(async schedule => {
          const nextRunAt = next(schedule, now);
          if (nextRunAt === null) {
            await tx.update(jobSchedules).set({ enabled: false }).where(eq(jobSchedules.id, schedule.id));
            return null;
          }
          const { job, created } = await this.jobs.insert(
            {
              kind: schedule.kind,
              payload: schedule.payload,
              workspaceId: schedule.workspaceId,
              runAt: now,
              dedupeKey: `${schedule.id}:${schedule.nextRunAt.toISOString()}`,
            },
            tx,
          );
          await tx.update(jobSchedules).set({ nextRunAt, lastEnqueuedAt: now }).where(eq(jobSchedules.id, schedule.id));
          return { scheduleId: schedule.id, jobId: job.id, created };
        }),
      );
      return results.filter(result => result !== null);
    });
  }
}
