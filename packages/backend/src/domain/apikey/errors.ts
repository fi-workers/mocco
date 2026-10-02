import { NotFoundError } from '@backend/domain/errors';

/** A flags:read key names an environment the project doesn't have — NOT_FOUND. */
export class KeyFlagEnvironmentNotFoundError extends NotFoundError {
  constructor(environmentId: string, options?: ErrorOptions) {
    super(`Flag environment ${environmentId} was not found in this project`, options);
    this.name = 'KeyFlagEnvironmentNotFoundError';
  }
}

export class ApiKeyNotFoundError extends NotFoundError {
  constructor(keyId: string, options?: ErrorOptions) {
    super(`API key ${keyId} was not found`, options);
    this.name = 'ApiKeyNotFoundError';
  }
}
