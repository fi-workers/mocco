import { NotFoundError } from '@backend/domain/errors';

/** A connection the caller's workspace doesn't own or that doesn't exist — NOT_FOUND. */
export class ProviderConnectionNotFoundError extends NotFoundError {
  constructor(id: string, options?: ErrorOptions) {
    super(`Connection ${id} was not found`, options);
    this.name = 'ProviderConnectionNotFoundError';
  }
}

/** A repo the caller's workspace doesn't own or that doesn't exist — NOT_FOUND. */
export class RepoNotFoundError extends NotFoundError {
  constructor(id: string, options?: ErrorOptions) {
    super(`Repo ${id} was not found`, options);
    this.name = 'RepoNotFoundError';
  }
}

/** A commit the caller's workspace doesn't own (via its repo) or that doesn't exist — NOT_FOUND. */
export class CommitNotFoundError extends NotFoundError {
  constructor(id: string, options?: ErrorOptions) {
    super(`Commit ${id} was not found`, options);
    this.name = 'CommitNotFoundError';
  }
}

/** The installing user could not be proven to administer the installation. */
export class OwnershipNotVerifiedError extends Error {
  constructor(options?: ErrorOptions) {
    super('Installation ownership could not be verified', options);
    this.name = 'OwnershipNotVerifiedError';
  }
}

/** The GitHub installation is already connected to a different workspace. An
 * installation is globally unique and belongs to one workspace; moving it requires
 * disconnecting from the current one first (rejected, not silently reassigned). */
export class ConnectionClaimedError extends Error {
  constructor(externalAccountId: string, options?: ErrorOptions) {
    super(`Installation ${externalAccountId} is already connected to another workspace`, options);
    this.name = 'ConnectionClaimedError';
  }
}

/** The connect `state` is unknown, already consumed, or expired. */
export class ConnectStateInvalidError extends Error {
  constructor(message = 'connect state invalid or expired', options?: ErrorOptions) {
    super(message, options);
    this.name = 'ConnectStateInvalidError';
  }
}
