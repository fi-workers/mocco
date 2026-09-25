import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '@backend/domain/errors';

import type { Product } from '@mocco/common/project';

/** A project the caller's workspace doesn't own or that doesn't exist — NOT_FOUND. */
export class ProjectNotFoundError extends NotFoundError {
  constructor(id: string, options?: ErrorOptions) {
    super(`Project ${id} was not found`, options);
    this.name = 'ProjectNotFoundError';
  }
}

/** An app that isn't in the given project (or doesn't exist) — NOT_FOUND. */
export class ProjectAppNotFoundError extends NotFoundError {
  constructor(id: string, options?: ErrorOptions) {
    super(`App ${id} was not found`, options);
    this.name = 'ProjectAppNotFoundError';
  }
}

/** A repo the workspace doesn't own (or that doesn't exist) — NOT_FOUND. */
export class ProjectRepoNotFoundError extends NotFoundError {
  constructor(id: string, options?: ErrorOptions) {
    super(`Repo ${id} was not found`, options);
    this.name = 'ProjectRepoNotFoundError';
  }
}

/** Another project in the workspace already uses this handle — CONFLICT. */
export class ProjectHandleTakenError extends ConflictError {
  constructor(handle: string, options?: ErrorOptions) {
    super(`The handle "${handle}" is already used by another project`, options);
    this.name = 'ProjectHandleTakenError';
  }
}

/** The project already has an app with this platform + bundle id — CONFLICT. */
export class ProjectAppBundleTakenError extends ConflictError {
  constructor(bundleId: string, options?: ErrorOptions) {
    super(`This project already has an app with bundle id "${bundleId}" on that platform`, options);
    this.name = 'ProjectAppBundleTakenError';
  }
}

/** The project is archived; it can be read and unarchived but not changed — BAD_REQUEST. */
export class ProjectArchivedError extends BadRequestError {
  constructor(id: string, options?: ErrorOptions) {
    super(`Project ${id} is archived`, options);
    this.name = 'ProjectArchivedError';
  }
}

/** Deploy governance is always on and cannot be disabled — BAD_REQUEST. */
export class ProductAlwaysEnabledError extends BadRequestError {
  constructor(product: Product, options?: ErrorOptions) {
    super(`The ${product} product is always enabled`, options);
    this.name = 'ProductAlwaysEnabledError';
  }
}

/** A product procedure was called in a workspace that hasn't enabled the product — FORBIDDEN. */
export class ProductNotEnabledError extends ForbiddenError {
  constructor(product: Product, options?: ErrorOptions) {
    super(`The ${product} product is not enabled in this workspace`, options);
    this.name = 'ProductNotEnabledError';
  }
}
