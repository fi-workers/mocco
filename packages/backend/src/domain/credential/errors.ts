import { NotFoundError } from '@backend/domain/errors';

/** A credential grant the caller's workspace doesn't own or that doesn't exist —
 * NOT_FOUND. A grant is NEVER resolved by id alone; always workspace-scoped. */
export class CredentialGrantNotFoundError extends NotFoundError {
  constructor(id: string, options?: ErrorOptions) {
    super(`Credential grant ${id} was not found`, options);
    this.name = 'CredentialGrantNotFoundError';
  }
}

/** A provider could not supply the requested credential (none is stored under that
 * name, or secret storage is not configured). The broker turns it into an audited
 * DENY — never a 500, and the caller still sees only the generic 403. */
export class CredentialUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CredentialUnavailableError';
  }
}
