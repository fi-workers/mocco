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

/** The uploaded file isn't the image it was declared as — BAD_REQUEST; its bytes are deleted. */
export class HelpImageNotAnImageError extends BadRequestError {
  constructor(declared: string, options?: ErrorOptions) {
    super(`The file isn't a ${declared} image. Add a PNG, JPEG, WebP or GIF image.`, options);
    this.name = 'HelpImageNotAnImageError';
  }
}

/** A language the help center doesn't offer — NOT_FOUND. */
export class HelpLocaleNotOfferedError extends NotFoundError {
  constructor(locale: string, options?: ErrorOptions) {
    super(`The help center isn't translated into ${locale}`, options);
    this.name = 'HelpLocaleNotOfferedError';
  }
}

/** Accepting a machine draft that isn't there, or isn't the one the reviewer saw — CONFLICT. */
export class HelpNoProposalError extends ConflictError {
  constructor(locale: string, options?: ErrorOptions) {
    super(
      `There's no machine draft in ${locale} for the current source, or a newer one replaced it. Look again.`,
      options,
    );
    this.name = 'HelpNoProposalError';
  }
}

/** Asking the machine to replace a reviewed translation without confirming it — BAD_REQUEST. */
export class TranslationOverwriteRequiresConfirmationError extends BadRequestError {
  constructor(locale: string, options?: ErrorOptions) {
    super(
      `The ${locale} translation was reviewed by a person; confirm to replace it with a machine translation`,
      options,
    );
    this.name = 'TranslationOverwriteRequiresConfirmationError';
  }
}

/** A glossary term that isn't in the project's help center — NOT_FOUND. */
export class HelpGlossaryTermNotFoundError extends NotFoundError {
  constructor(termId: string, options?: ErrorOptions) {
    super(`No glossary term ${termId}`, options);
    this.name = 'HelpGlossaryTermNotFoundError';
  }
}

/** The glossary already has the term, in some case — CONFLICT. */
export class HelpGlossaryTermExistsError extends ConflictError {
  constructor(term: string, options?: ErrorOptions) {
    super(`The glossary already has "${term}"`, options);
    this.name = 'HelpGlossaryTermExistsError';
  }
}

/** The glossary would hold more terms than a help center may have — BAD_REQUEST. */
export class HelpGlossaryFullError extends BadRequestError {
  constructor(max: number, options?: ErrorOptions) {
    super(`A help center's glossary holds up to ${String(max)} terms`, options);
    this.name = 'HelpGlossaryFullError';
  }
}
