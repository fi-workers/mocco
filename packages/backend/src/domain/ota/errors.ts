import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '@backend/domain/errors';

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

/** OTA hosting serves a project's React Native app; other platforms can't host updates. */
export class NotAReactNativeAppError extends BadRequestError {
  constructor(appId: string, options?: ErrorOptions) {
    super(`App ${appId} is not a React Native app, so it can't host OTA updates`, options);
    this.name = 'NotAReactNativeAppError';
  }
}

export class OtaAppNotFoundError extends NotFoundError {
  constructor(appId: string, options?: ErrorOptions) {
    super(`OTA app ${appId} was not found`, options);
    this.name = 'OtaAppNotFoundError';
  }
}

export class OtaAppAlreadyExistsError extends ConflictError {
  constructor(options?: ErrorOptions) {
    super('This app already hosts OTA updates', options);
    this.name = 'OtaAppAlreadyExistsError';
  }
}

export class OtaChannelNotFoundError extends NotFoundError {
  constructor(channelId: string, options?: ErrorOptions) {
    super(`OTA channel ${channelId} was not found`, options);
    this.name = 'OtaChannelNotFoundError';
  }
}

export class OtaChannelNameTakenError extends ConflictError {
  constructor(name: string, options?: ErrorOptions) {
    super(`The app already has a channel named "${name}"`, options);
    this.name = 'OtaChannelNameTakenError';
  }
}

export class OtaChannelChangedError extends ConflictError {
  constructor(options?: ErrorOptions) {
    super('The channel changed since you loaded it; reload and try again', options);
    this.name = 'OtaChannelChangedError';
  }
}

/** The PEM isn't a usable code-signing certificate (not X.509, not RSA, or expired). */
export class InvalidSigningCertificateError extends BadRequestError {
  constructor(reason: string, options?: ErrorOptions) {
    super(`The signing certificate can't be used: ${reason}`, options);
    this.name = 'InvalidSigningCertificateError';
  }
}

export class SigningCertificateExistsError extends ConflictError {
  constructor(options?: ErrorOptions) {
    super('This certificate is already registered for the app', options);
    this.name = 'SigningCertificateExistsError';
  }
}

export class SigningCertificateNotFoundError extends NotFoundError {
  constructor(certificateId: string, options?: ErrorOptions) {
    super(`Signing certificate ${certificateId} was not found`, options);
    this.name = 'SigningCertificateNotFoundError';
  }
}

/** An upload or finalize the CLI must fix: the message says exactly what is wrong. */
export class OtaUploadRejectedError extends BadRequestError {
  constructor(reason: string, options?: ErrorOptions) {
    super(reason, options);
    this.name = 'OtaUploadRejectedError';
  }
}

/** The key's project doesn't own the OTA app (reported like a missing app). */
export class OtaUploadForbiddenError extends ForbiddenError {
  constructor(options?: ErrorOptions) {
    super("This key can't upload to that OTA app", options);
    this.name = 'OtaUploadForbiddenError';
  }
}

export class OtaReleaseNotFoundError extends NotFoundError {
  constructor(releaseId: string, options?: ErrorOptions) {
    super(`OTA release ${releaseId} was not found`, options);
    this.name = 'OtaReleaseNotFoundError';
  }
}

/** The session already uploaded a release, or the release was already finalized. */
export class OtaUploadConflictError extends ConflictError {
  constructor(reason: string, options?: ErrorOptions) {
    super(reason, options);
    this.name = 'OtaUploadConflictError';
  }
}

/** Promotion needs a `ready` release (assets re-hashed, invariant 2). */
export class OtaReleaseNotReadyError extends BadRequestError {
  constructor(releaseId: string, status: string, options?: ErrorOptions) {
    super(`Release ${releaseId} is ${status}; only ready releases can be promoted`, options);
    this.name = 'OtaReleaseNotReadyError';
  }
}

/** Devices load only a newer commitTime, so promoting an older release would reach no one. */
export class OtaReleaseOlderThanHeadError extends ConflictError {
  constructor(channel: string, platform: string, options?: ErrorOptions) {
    super(
      `The release is older than what "${channel}" serves on ${platform}; devices only load newer updates, so roll back instead`,
      options,
    );
    this.name = 'OtaReleaseOlderThanHeadError';
  }
}

/** A protected channel changes only through an approval (invariant 6). */
export class OtaChannelProtectedError extends ForbiddenError {
  constructor(channel: string, options?: ErrorOptions) {
    super(`Channel "${channel}" is protected; promoting to it needs an approved request`, options);
    this.name = 'OtaChannelProtectedError';
  }
}
