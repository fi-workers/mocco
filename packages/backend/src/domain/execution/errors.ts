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
