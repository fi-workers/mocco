import { NotFoundError } from '../errors';

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

/** The installing user could not be proven to administer the installation. */
export class OwnershipNotVerifiedError extends Error {
  constructor(options?: ErrorOptions) {
    super('Installation ownership could not be verified', options);
    this.name = 'OwnershipNotVerifiedError';
  }
}

/** The connect `state` is unknown, already consumed, or expired. */
export class ConnectStateInvalidError extends Error {
  constructor(message = 'connect state invalid or expired', options?: ErrorOptions) {
    super(message, options);
    this.name = 'ConnectStateInvalidError';
  }
}
