/**
 * Lifecycle of a background job row (`mocco_jobs.status`). The single source of
 * truth: the DB check and the job repos reference this object, never a raw string.
 *
 * - `queued`: waiting for `run_at`; a failed attempt with retries left goes back here.
 * - `running`: claimed by a runner until `locked_until`.
 * - `succeeded`: the handler returned.
 * - `failed`: reserved by the platform design (§7) and allowed by the DB check; the
 *   runner never writes it today (a failed attempt re-queues or dead-letters).
 * - `dead`: out of attempts, or a payload that can never parse. Kept 30 days.
 */
export const JobStatuses = {
  queued: 'queued',
  running: 'running',
  succeeded: 'succeeded',
  failed: 'failed',
  dead: 'dead',
} as const;
export type JobStatus = (typeof JobStatuses)[keyof typeof JobStatuses];
