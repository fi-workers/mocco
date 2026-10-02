import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '@backend/domain/errors';

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

/** The changeset was already applied, rejected, withdrawn, superseded or expired — CONFLICT. */
export class ChangesetNotPendingError extends ConflictError {
  constructor(changesetId: string, state: string, options?: ErrorOptions) {
    super(`Changeset ${changesetId} is ${state}, not pending`, options);
    this.name = 'ChangesetNotPendingError';
  }
}

/** A vote names a content hash the changeset doesn't have (the reviewer saw an older
 * proposal) — CONFLICT. */
export class ChangesetHashMismatchError extends ConflictError {
  constructor(options?: ErrorOptions) {
    super('This changeset is not the one you reviewed; reload and review it again', options);
    this.name = 'ChangesetHashMismatchError';
  }
}

/** Only the person who proposed a changeset can withdraw or rebase it — FORBIDDEN. */
export class NotChangesetProposerError extends ForbiddenError {
  constructor(options?: ErrorOptions) {
    super('Only the person who proposed this changeset can withdraw or rebase it', options);
    this.name = 'NotChangesetProposerError';
  }
}

/** A changeset that isn't on file — NOT_FOUND. */
export class ChangesetNotFoundError extends NotFoundError {
  constructor(changesetId: string, options?: ErrorOptions) {
    super(`Changeset ${changesetId} was not found`, options);
    this.name = 'ChangesetNotFoundError';
  }
}

/** The compiled ruleset would exceed its size limit — BAD_REQUEST. */
export class RulesetTooLargeError extends BadRequestError {
  constructor(bytes: number, limit: number, options?: ErrorOptions) {
    super(
      `This change makes the environment's ruleset ${Math.ceil(bytes / 1024)} KB, over the ${limit / 1024 / 1024} MB limit; move large key lists out of segments`,
      options,
    );
    this.name = 'RulesetTooLargeError';
  }
}
