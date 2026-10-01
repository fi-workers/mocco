import { BadRequestError, NotFoundError } from '@backend/domain/errors';

/** The product has no storage policy, so it can't store objects. */
export class StorageProductNotAllowedError extends BadRequestError {
  constructor(product: string, options?: ErrorOptions) {
    super(`The ${product} product can't store objects`, options);
    this.name = 'StorageProductNotAllowedError';
  }
}

/** The content type isn't allowed for the product. */
export class StorageContentTypeNotAllowedError extends BadRequestError {
  constructor(contentType: string, options?: ErrorOptions) {
    super(`Content type ${contentType} isn't allowed here`, options);
    this.name = 'StorageContentTypeNotAllowedError';
  }
}

/** The object is bigger than the product allows. */
export class StorageObjectTooLargeError extends BadRequestError {
  constructor(maxBytes: number, options?: ErrorOptions) {
    super(`Objects can be at most ${maxBytes} bytes`, options);
    this.name = 'StorageObjectTooLargeError';
  }
}

/** Storing it would exceed the workspace's quota. */
export class StorageQuotaExceededError extends BadRequestError {
  constructor(options?: ErrorOptions) {
    super('The workspace storage quota is used up', options);
    this.name = 'StorageQuotaExceededError';
  }
}

/** The uploaded bytes don't match what was declared (missing, other size or type). */
export class StorageUploadMismatchError extends BadRequestError {
  constructor(reason: string, options?: ErrorOptions) {
    super(`The upload doesn't match what was declared: ${reason}`, options);
    this.name = 'StorageUploadMismatchError';
  }
}

export class StoredObjectNotFoundError extends NotFoundError {
  constructor(objectId: string, options?: ErrorOptions) {
    super(`Object ${objectId} was not found`, options);
    this.name = 'StoredObjectNotFoundError';
  }
}

/** This deployment has no object store configured. */
export class StorageUnavailableError extends BadRequestError {
  constructor(options?: ErrorOptions) {
    super('Object storage is not configured (set STORAGE_DRIVER)', options);
    this.name = 'StorageUnavailableError';
  }
}
