import { ConflictError, NotFoundError } from '@backend/domain/errors';

/** A status page, group or component the project doesn't have — NOT_FOUND. */
export class StatusEntityNotFoundError extends NotFoundError {
  constructor(kind: 'page' | 'group' | 'component', id: string, options?: ErrorOptions) {
    super(`Status ${kind} ${id} was not found`, options);
    this.name = 'StatusEntityNotFoundError';
  }
}

/** Another status page already uses the slug (slugs are global) — CONFLICT. */
export class StatusPageSlugTakenError extends ConflictError {
  constructor(slug: string, options?: ErrorOptions) {
    super(`The status page address "${slug}" is taken`, options);
    this.name = 'StatusPageSlugTakenError';
  }
}
