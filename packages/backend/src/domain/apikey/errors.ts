import { NotFoundError } from '@backend/domain/errors';

export class ApiKeyNotFoundError extends NotFoundError {
  constructor(keyId: string, options?: ErrorOptions) {
    super(`API key ${keyId} was not found`, options);
    this.name = 'ApiKeyNotFoundError';
  }
}
