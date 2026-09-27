export interface RetryAtOptions {
  /**
   * `false` for a wait that is not a failure (a shared rate limit bucket, a fairness
   * quota, a paused dependency): the runner always refunds the attempt and does not
   * count it towards `JobPolicy.maxConsecutiveDeferrals`, so such waits never make the
   * job `dead`. The handler must bound them itself (e.g. by the age of its work item).
   * Default `true`.
   */
  consumesAttempt?: boolean;
}

/**
 * Thrown by a job handler to be retried at a specific time instead of the generic
 * backoff (e.g. Discord's `retry_after`). The runner re-queues the job with
 * `run_at = at` (never earlier than now) and refunds the attempt, up to
 * `JobPolicy.maxConsecutiveDeferrals` times in a row; after that each RetryAt counts as
 * an attempt and the job ends `dead` once `max_attempts` is spent. A RetryAt with
 * `{ consumesAttempt: false }` is always refunded and never counted.
 */
export class RetryAt extends Error {
  /** The wait is free: always refunded, never counted as a deferral. */
  readonly isFreeWait: boolean;

  constructor(
    readonly at: Date,
    reason = 'retry requested by the handler',
    options: RetryAtOptions = {},
  ) {
    super(reason);
    this.name = 'RetryAt';
    this.isFreeWait = options.consumesAttempt === false;
  }
}
