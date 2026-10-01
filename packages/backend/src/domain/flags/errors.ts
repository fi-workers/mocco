import { BadRequestError, ConflictError, NotFoundError } from '@backend/domain/errors';

/** An environment the project doesn't have — NOT_FOUND. */
export class FlagEnvironmentNotFoundError extends NotFoundError {
  constructor(id: string, options?: ErrorOptions) {
    super(`Flag environment ${id} was not found`, options);
    this.name = 'FlagEnvironmentNotFoundError';
  }
}

/** A flag the project doesn't have — NOT_FOUND. */
export class FlagNotFoundError extends NotFoundError {
  constructor(key: string, options?: ErrorOptions) {
    super(`Flag "${key}" was not found`, options);
    this.name = 'FlagNotFoundError';
  }
}

/** The project already has an environment or a flag with this key — CONFLICT. */
export class FlagKeyTakenError extends ConflictError {
  constructor(kind: 'environment' | 'flag', key: string, options?: ErrorOptions) {
    super(`This project already has ${kind === 'flag' ? 'a flag' : 'an environment'} with the key "${key}"`, options);
    this.name = 'FlagKeyTakenError';
  }
}

/** An op that doesn't apply to the environment's current configs — BAD_REQUEST. */
export class InvalidChangeError extends BadRequestError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'InvalidChangeError';
  }
}

/** The environment moved past the changeset's base version — CONFLICT. */
export class ChangesetConflictError extends ConflictError {
  readonly environmentId: string;

  constructor(environmentId: string, baseVersion: number, currentVersion: number, options?: ErrorOptions) {
    super(
      `This environment changed meanwhile (version ${baseVersion} → ${currentVersion}); review its current state and try again`,
      options,
    );
    this.environmentId = environmentId;
    this.name = 'ChangesetConflictError';
  }
}

/** A change to a protected environment needs approval, which arrives with gated
 * changesets (#141); until then it is refused rather than applied ungated — BAD_REQUEST. */
export class ProtectedEnvironmentError extends BadRequestError {
  constructor(environmentId: string, options?: ErrorOptions) {
    super(`Environment ${environmentId} is protected; its changes need approval`, options);
    this.name = 'ProtectedEnvironmentError';
  }
}
