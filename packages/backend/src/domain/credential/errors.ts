import { NotFoundError } from '@backend/domain/errors';

/** A credential grant the caller's workspace doesn't own or that doesn't exist —
 * NOT_FOUND. A grant is NEVER resolved by id alone; always workspace-scoped. */
export class CredentialGrantNotFoundError extends NotFoundError {
  constructor(id: string, options?: ErrorOptions) {
    super(`Credential grant ${id} was not found`, options);
    this.name = 'CredentialGrantNotFoundError';
  }
}
