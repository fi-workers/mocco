/**
 * Thrown by a job handler to be retried at a specific time instead of the generic
 * backoff (e.g. Discord's `retry_after`). The runner re-queues the job with
 * `run_at = at` (never earlier than now) and refunds the attempt, up to
 * `JobPolicy.maxConsecutiveDeferrals` times in a row; after that each RetryAt counts as
 * an attempt and the job ends `dead` once `max_attempts` is spent.
 */
export class RetryAt extends Error {
  constructor(
    readonly at: Date,
    reason = 'retry requested by the handler',
  ) {
    super(reason);
    this.name = 'RetryAt';
  }
}
