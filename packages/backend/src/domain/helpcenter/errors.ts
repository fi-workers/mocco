import { BadRequestError, ConflictError, NotFoundError } from '@backend/domain/errors';

/** The project has no help center yet — NOT_FOUND; the public site answers 404 too. */
export class HelpSiteNotFoundError extends NotFoundError {
  constructor(what: string, options?: ErrorOptions) {
    super(`No help center for ${what}`, options);
    this.name = 'HelpSiteNotFoundError';
  }
}

/** The project already has a help center — CONFLICT. */
export class HelpSiteExistsError extends ConflictError {
  constructor(projectId: string, options?: ErrorOptions) {
    super(`Project ${projectId} already has a help center`, options);
    this.name = 'HelpSiteExistsError';
  }
}

/** Another help center already uses the slug — CONFLICT. */
export class HelpSlugTakenError extends ConflictError {
  constructor(slug: string, options?: ErrorOptions) {
    super(`The address ${slug} is taken`, options);
    this.name = 'HelpSlugTakenError';
  }
}

/** A collection, section or article that isn't in the project — NOT_FOUND. */
export class HelpNodeNotFoundError extends NotFoundError {
  constructor(kind: 'collection' | 'section' | 'article' | 'revision', id: string, options?: ErrorOptions) {
    super(`No ${kind} ${id}`, options);
    this.name = 'HelpNodeNotFoundError';
  }
}

/** Publishing an article that has no text yet — CONFLICT. */
export class HelpNothingToPublishError extends ConflictError {
  constructor(articleId: string, options?: ErrorOptions) {
    super(`Article ${articleId} has no draft to publish`, options);
    this.name = 'HelpNothingToPublishError';
  }
}

/** Image uploads need object storage, which this deployment hasn't configured — BAD_REQUEST. */
export class HelpStorageNotConfiguredError extends BadRequestError {
  constructor(options?: ErrorOptions) {
    super("Images can't be uploaded: object storage isn't configured", options);
    this.name = 'HelpStorageNotConfiguredError';
  }
}
