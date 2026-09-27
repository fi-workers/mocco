import { BadRequestError, ConflictError, NotFoundError } from '@backend/domain/errors';

/** Version policies apply to store builds only (iOS and Android apps) — BAD_REQUEST. */
export class NotAStoreAppError extends BadRequestError {
  constructor(appId: string, options?: ErrorOptions) {
    super(`App ${appId} is not an iOS or Android app; version policies apply to store apps only`, options);
    this.name = 'NotAStoreAppError';
  }
}

/** Raising a version floor needs confirmation that the version is live on the store — BAD_REQUEST. */
export class StoreLiveAttestationRequiredError extends BadRequestError {
  constructor(options?: ErrorOptions) {
    super('Confirm that the new minimum or recommended version is live on the store before raising it', options);
    this.name = 'StoreLiveAttestationRequiredError';
  }
}

/** The policy changed while the request was being made (a concurrent edit) — BAD_REQUEST. */
export class VersionPolicyConflictError extends BadRequestError {
  constructor(appId: string, options?: ErrorOptions) {
    super(`The version policy of app ${appId} changed meanwhile; reload and try again`, options);
    this.name = 'VersionPolicyConflictError';
  }
}

/** An external OTA credential the project doesn't have — NOT_FOUND. */
export class OtaCredentialNotFoundError extends NotFoundError {
  constructor(id: string, options?: ErrorOptions) {
    super(`OTA credential ${id} was not found`, options);
    this.name = 'OtaCredentialNotFoundError';
  }
}

/** Another credential in the workspace already uses this name — CONFLICT. */
export class OtaCredentialNameTakenError extends ConflictError {
  constructor(name: string, options?: ErrorOptions) {
    super(`An OTA credential named "${name}" already exists in this workspace`, options);
    this.name = 'OtaCredentialNameTakenError';
  }
}

/** This server has no SecretBox key, so it cannot store secrets — BAD_REQUEST. */
export class SecretStorageUnavailableError extends BadRequestError {
  constructor(options?: ErrorOptions) {
    super('This server is not configured to store secrets (SECRETS_ENCRYPTION_KEYS is not set)', options);
    this.name = 'SecretStorageUnavailableError';
  }
}
