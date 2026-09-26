// Pure job policy: backoff, schedule slots and the RetryAt cap. No I/O, so the
// runner and repos stay thin and every rule here is unit-tested with fixed inputs.
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Time limits that must stay ordered: `visibilityMs > functionMaxDurationMs >
 * maxTickBudgetMs >= defaultTickBudgetMs` (unit-tested).
 *
 * - A claim's lock must outlive the function running it, or a run that is still going
 *   gets reclaimed and started a second time.
 * - A tick must stop claiming well before the platform kills the function, so the job it
 *   is on can finish.
 *
 * `functionMaxDurationMs` mirrors the literal `export const maxDuration = 300` in
 * packages/frontend/src/app/api/ext/[[...route]]/route.ts (Next reads it statically; a
 * test keeps the two equal). `defaultTickBudgetMs` mirrors the JOBS_TICK_BUDGET_MS default.
 */
export const JobTiming = {
  visibilityMs: 10 * MINUTE,
  functionMaxDurationMs: 300 * SECOND,
  /** JOBS_TICK_BUDGET_MS is clamped to this. */
  maxTickBudgetMs: 240 * SECOND,
  defaultTickBudgetMs: 50 * SECOND,
} as const;

export const JobPolicy = {
  /** First retry waits 2^1 × this. */
  baseDelayMs: 15 * SECOND,
  /** Upper bound of the exponential part of the backoff. */
  maxDelayMs: 6 * HOUR,
  /** Random extra delay, as a fraction of the base delay, so retries don't stampede. */
  jitterRatio: 0.25,
  /** Attempts a job gets unless its enqueuer says otherwise (matches the DB default). */
  defaultMaxAttempts: 8,
  /** How long a claim holds a job before `reclaimExpired` hands it to another runner. */
  defaultVisibilityMs: JobTiming.visibilityMs,
  /**
   * RetryAt reschedules in a row that do not spend an attempt. Past this, each further
   * RetryAt counts as an attempt, so a handler that always asks for "later" still ends
   * `dead` after `max_attempts` instead of looping forever.
   */
  maxConsecutiveDeferrals: 5,
  /** Retention for `jobs.prune`. */
  succeededRetentionMs: 7 * DAY,
  deadRetentionMs: 30 * DAY,
  /** `last_error` is truncated to this many characters. */
  lastErrorMaxLength: 2000,
} as const;

/** Delay before the next attempt after `attempts` attempts:
 * `min(2^attempts × 15s, 6h)` plus up to 25% jitter. `random` returns [0, 1). */
export function retryDelayMs(attempts: number, random: () => number): number {
  const base = Math.min(2 ** attempts * JobPolicy.baseDelayMs, JobPolicy.maxDelayMs);
  return base + base * JobPolicy.jitterRatio * random();
}

/** The first slot `slot + k × interval` (k ≥ 1) strictly after `now`. Missed slots are
 * skipped, so a schedule that was down for a day fires once, not once per missed slot. */
export function nextIntervalSlot(slot: Date, intervalSeconds: number, now: Date): Date {
  const intervalMs = intervalSeconds * SECOND;
  const elapsed = now.getTime() - slot.getTime();
  const steps = Math.max(1, Math.floor(elapsed / intervalMs) + 1);
  return new Date(slot.getTime() + steps * intervalMs);
}

/** The next run of a schedule, or `null` when the tick cannot compute one. Cron
 * expressions are reserved in the schema but not evaluated yet (no parser dependency). */
export function nextScheduleRun(schedule: { nextRunAt: Date; intervalSeconds: number | null }, now: Date): Date | null {
  return schedule.intervalSeconds === null ? null : nextIntervalSlot(schedule.nextRunAt, schedule.intervalSeconds, now);
}

/** A thrown value as a bounded `last_error` string. */
export function describeError(error: unknown): string {
  return String(error instanceof Error ? error.message : error).slice(0, JobPolicy.lastErrorMaxLength);
}
