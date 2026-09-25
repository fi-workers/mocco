import { describeError, JobPolicy, nextScheduleRun, retryDelayMs } from '@backend/domain/jobs/policy';
import { RetryAt } from '@backend/domain/jobs/retry-at';

import type { JobHandler, JobHandlerRegistry } from '@backend/domain/jobs/handlers';
import type { JobScheduleRepo, SystemSchedule } from '@backend/domain/jobs/repos/job-schedule.repo';
import type { Job, JobRepo } from '@backend/domain/jobs/repos/job.repo';

/** What happened to one claimed job. */
export const JobOutcomes = {
  succeeded: 'succeeded',
  /** Failed; re-queued with backoff. */
  retried: 'retried',
  /** RetryAt; re-queued at the handler's time. */
  deferred: 'deferred',
  dead: 'dead',
  /** The claim expired and another runner took the job before this one finished. */
  lost: 'lost',
} as const;
export type JobOutcome = (typeof JobOutcomes)[keyof typeof JobOutcomes];

/** The steps of a tick. Each is isolated: one failing is logged and reported, and the
 * rest still run, so a broken schedule never stops queued jobs from draining. */
export const TickPhases = {
  ensureSchedules: 'ensureSchedules',
  reclaimExpired: 'reclaimExpired',
  advanceDue: 'advanceDue',
  drain: 'drain',
} as const;
export type TickPhase = (typeof TickPhases)[keyof typeof TickPhases];

export interface TickError {
  phase: TickPhase;
  message: string;
}

export interface TickOptions {
  /** Stop claiming new jobs once this much time has passed since the tick started. */
  budgetMs: number;
  /** Upper bound on jobs run by this tick. */
  maxJobs: number;
}

export interface TickReport {
  reclaimed: number;
  /** Jobs newly enqueued from due schedules. */
  scheduled: number;
  ran: number;
  outcomes: Record<JobOutcome, number>;
  /** Phases that threw (empty on a clean tick). */
  errors: TickError[];
}

export interface JobRunnerDeps {
  jobs: JobRepo;
  schedules: JobScheduleRepo;
  handlers: JobHandlerRegistry;
  now: () => Date;
  /** [0, 1) — backoff jitter. */
  random: () => number;
  /** Identifies this runner in `locked_by`. */
  workerId: string;
  visibilityMs?: number;
  /** Platform schedules ensured at the start of every tick (e.g. the daily `jobs.prune`). */
  systemSchedules?: readonly SystemSchedule[];
}

/** Count outcomes per kind of outcome. */
const tally = (outcomes: readonly JobOutcome[]): Record<JobOutcome, number> =>
  outcomes.reduce((counts, outcome) => ({ ...counts, [outcome]: counts[outcome] + 1 }), {
    succeeded: 0,
    retried: 0,
    deferred: 0,
    dead: 0,
    lost: 0,
  });

/** Run one tick phase; a throw is logged and returned as a TickError instead. */
async function guarded<T>(
  phase: TickPhase,
  fallback: T,
  step: () => Promise<T>,
): Promise<{ value: T; error?: TickError }> {
  try {
    return { value: await step() };
  } catch (error) {
    console.error(`[jobs] tick phase ${phase} failed`, error);
    return { value: fallback, error: { phase, message: describeError(error) } };
  }
}

/** A post-claim write that matched no row means another runner reclaimed the job. */
const unlessLost = (isWritten: boolean, outcome: JobOutcome): JobOutcome => (isWritten ? outcome : JobOutcomes.lost);

/**
 * Drains the job table. `tick` is the single entry point every driver calls (Vercel
 * Cron, a self-host cron, curl): ensure system schedules → reclaim expired locks →
 * enqueue due schedule slots → run due jobs one at a time until the budget or
 * `maxJobs` runs out. Jobs it doesn't reach stay queued for the next tick, and a tick
 * never runs the same job twice (a job it re-queued for "now" waits for the next tick).
 */
export class JobRunner {
  private readonly visibilityMs: number;

  constructor(private readonly deps: JobRunnerDeps) {
    this.visibilityMs = deps.visibilityMs ?? JobPolicy.defaultVisibilityMs;
  }

  /** Run due jobs one at a time. `outcomes` is appended to in place, so a failure
   * mid-drain still reports what already ran. */
  private async drain(deadline: number, remaining: number, done: readonly Job[], outcomes: JobOutcome[]) {
    if (remaining <= 0 || this.deps.now().getTime() >= deadline) {
      return;
    }
    const [job] = await this.claim({ excludeIds: done.map(entry => entry.id) });
    if (!job) {
      return;
    }
    outcomes.push(await this.execute(job));
    await this.drain(deadline, remaining - 1, [...done, job], outcomes);
  }

  private async ensureSchedules(): Promise<void> {
    const { schedules, systemSchedules = [] } = this.deps;
    // Sequential: pg deprecates concurrent queries on one client.
    await systemSchedules.reduce<Promise<void>>(async (previous, schedule) => {
      await previous;
      await schedules.ensureSystem(schedule, this.deps.now());
    }, Promise.resolve());
  }

  private async claim(filter: { id?: string; excludeIds?: readonly string[] }): Promise<Job[]> {
    return await this.deps.jobs.claim({
      now: this.deps.now(),
      limit: 1,
      visibilityMs: this.visibilityMs,
      workerId: this.deps.workerId,
      ...filter,
    });
  }

  private async execute(job: Job): Promise<JobOutcome> {
    const handler = this.deps.handlers.get(job.kind);
    if (!handler) {
      // Retryable: during a deploy an older runner may see a kind only newer code knows.
      return await this.failed(job, new Error(`no handler registered for kind "${job.kind}"`));
    }
    const parsed = handler.payload.safeParse(job.payload);
    if (!parsed.success) {
      // A payload that doesn't parse now never will: dead-letter without retrying.
      return await this.dead(job, `invalid payload: ${parsed.error.message}`);
    }
    return await this.run(handler, job, parsed.data);
  }

  private async run(handler: JobHandler, job: Job, payload: unknown): Promise<JobOutcome> {
    try {
      await handler.run(payload, {
        jobId: job.id,
        kind: job.kind,
        attempt: job.attempts,
        workspaceId: job.workspaceId,
        now: this.deps.now,
        deadline: job.lockedUntil ?? new Date(this.deps.now().getTime() + this.visibilityMs),
      });
    } catch (error) {
      return error instanceof RetryAt ? await this.deferred(job, error) : await this.failed(job, error);
    }
    return unlessLost(await this.deps.jobs.complete(job, this.deps.now()), JobOutcomes.succeeded);
  }

  private async failed(job: Job, error: unknown): Promise<JobOutcome> {
    if (job.attempts >= job.maxAttempts) {
      return await this.dead(job, describeError(error));
    }
    const now = this.deps.now();
    const retryAt = new Date(now.getTime() + retryDelayMs(job.attempts, this.deps.random));
    const isWritten = await this.deps.jobs.fail(job, { now, error: describeError(error), retryAt });
    return unlessLost(isWritten, JobOutcomes.retried);
  }

  private async deferred(job: Job, retry: RetryAt): Promise<JobOutcome> {
    const now = this.deps.now();
    const runAt = retry.at.getTime() < now.getTime() ? now : retry.at;
    const shouldRefund = job.deferrals < JobPolicy.maxConsecutiveDeferrals;
    if (!shouldRefund && job.attempts >= job.maxAttempts) {
      return await this.dead(
        job,
        `RetryAt requested more than ${JobPolicy.maxConsecutiveDeferrals} times in a row and attempts ran out: ${describeError(retry)}`,
      );
    }
    const isWritten = await this.deps.jobs.defer(job, {
      runAt,
      reason: describeError(retry),
      refundAttempt: shouldRefund,
    });
    return unlessLost(isWritten, JobOutcomes.deferred);
  }

  private async dead(job: Job, error: string): Promise<JobOutcome> {
    console.warn(`[jobs] ${job.kind} ${job.id} is dead: ${error}`);
    const isWritten = await this.deps.jobs.fail(job, { now: this.deps.now(), error, retryAt: null });
    return unlessLost(isWritten, JobOutcomes.dead);
  }

  async tick(options: TickOptions): Promise<TickReport> {
    const { jobs, schedules } = this.deps;
    const deadline = this.deps.now().getTime() + options.budgetMs;
    const ensured = await guarded(TickPhases.ensureSchedules, undefined, async () => {
      await this.ensureSchedules();
    });
    const reclaimed = await guarded(
      TickPhases.reclaimExpired,
      0,
      async () => await jobs.reclaimExpired(this.deps.now()),
    );
    const enqueued = await guarded(
      TickPhases.advanceDue,
      [],
      async () => await schedules.advanceDue({ now: this.deps.now(), limit: options.maxJobs, next: nextScheduleRun }),
    );
    const outcomes: JobOutcome[] = [];
    const drained = await guarded(TickPhases.drain, undefined, async () => {
      await this.drain(deadline, options.maxJobs, [], outcomes);
    });
    return {
      reclaimed: reclaimed.value,
      scheduled: enqueued.value.filter(entry => entry.created).length,
      ran: outcomes.length,
      outcomes: tally(outcomes),
      errors: [ensured.error, reclaimed.error, enqueued.error, drained.error].filter(error => error !== undefined),
    };
  }

  /** Claim and run one specific job now (the `kick` path). null when it isn't claimable
   * (already running or finished, or not due yet). */
  async runOne(id: string): Promise<JobOutcome | null> {
    const [job] = await this.claim({ id });
    return job ? await this.execute(job) : null;
  }
}
