import { BadRequestError, NotFoundError } from '@backend/domain/errors';

/** A run the caller's workspace doesn't own or that doesn't exist — NOT_FOUND. */
export class RunNotFoundError extends NotFoundError {
  constructor(id: string, options?: ErrorOptions) {
    super(`Run ${id} was not found`, options);
    this.name = 'RunNotFoundError';
  }
}

/**
 * A commit whose `.mocco.yml` snapshot is absent or invalid cannot be run.
 *
 * This is a precondition failure, NOT a not-found: the commit itself resolves
 * fine (it's the caller's, it exists) — it's the *state* of its config snapshot
 * that makes triggering illegal. A missing/invalid config is a 400-class
 * "you asked for something that isn't valid right now", not a 404. So it extends
 * `BadRequestError` (maps to tRPC BAD_REQUEST) rather than `NotFoundError`.
 */
export class ConfigNotRunnableError extends BadRequestError {
  constructor(commitId: string, options?: ErrorOptions) {
    super(`Commit ${commitId} has no runnable config (its .mocco.yml is absent or invalid)`, options);
    this.name = 'ConfigNotRunnableError';
  }
}

/**
 * A callback that can't be applied: an unknown run, a token that fails the
 * constant-time hash check, or a step index that isn't the run's current cursor.
 * It never reaches a tRPC router (callbacks are ext-only) — the ext route catches
 * it and returns a fixed generic status, leaking neither existence nor detail.
 * Extends `BadRequestError` (the illegal-state family) for a consistent base.
 */
export class RunCallbackRejectedError extends BadRequestError {
  constructor(reason: string, options?: ErrorOptions) {
    super(`Run callback rejected: ${reason}`, options);
    this.name = 'RunCallbackRejectedError';
  }
}

/**
 * A step whose pinned `executor` id has no adapter registered in the executor
 * registry (ADR 0004). Fail-closed: the run is failed with a clear step/run event,
 * never dispatched to a silent no-op. Unlike the other classes here it does NOT
 * reach a tRPC router — the executor is resolved in the deferred (fire-and-forget)
 * dispatch pass, so this is recorded on the run (a `step.failed`/`run.failed`) and
 * logged, never thrown to a caller. It extends `BadRequestError` (the illegal-state
 * family: an unknown executor in a config is an un-runnable precondition) for a
 * consistent base and message shape.
 */
export class UnknownExecutorError extends BadRequestError {
  constructor(executorId: string, options?: ErrorOptions) {
    super(`No executor adapter is registered for '${executorId}'`, options);
    this.name = 'UnknownExecutorError';
  }
}
