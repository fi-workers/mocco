import { NotFoundError } from '@backend/domain/errors';

/** A role the caller's workspace doesn't own or that doesn't exist — NOT_FOUND. */
export class RoleNotFoundError extends NotFoundError {
  constructor(id: string, options?: ErrorOptions) {
    super(`Role ${id} was not found`, options);
    this.name = 'RoleNotFoundError';
  }
}
