import { BadRequestError } from '@backend/domain/errors';

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
