import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '@backend/domain/errors';

/** The project hasn't set up its messenger — NOT_FOUND on the operator side; /v1 answers 404 too. */
export class MessengerNotEnabledError extends NotFoundError {
  constructor(projectId: string, options?: ErrorOptions) {
    super(`Messenger isn't set up for project ${projectId}`, options);
    this.name = 'MessengerNotEnabledError';
  }
}

/** The project already has a messenger — CONFLICT. */
export class MessengerAlreadyEnabledError extends ConflictError {
  constructor(projectId: string, options?: ErrorOptions) {
    super(`Messenger is already set up for project ${projectId}`, options);
    this.name = 'MessengerAlreadyEnabledError';
  }
}

/** The user hash doesn't match the user id (wrong secret, or not signed by the app's server) — 401. */
export class IdentityVerificationError extends ForbiddenError {
  constructor(options?: ErrorOptions) {
    super("The user's identity couldn't be verified", options);
    this.name = 'IdentityVerificationError';
  }
}

/** A blocked contact can't write — FORBIDDEN. */
export class ContactBlockedError extends ForbiddenError {
  constructor(options?: ErrorOptions) {
    super('This user is blocked from contacting the team', options);
    this.name = 'ContactBlockedError';
  }
}

/** A conversation the caller can't see — NOT_FOUND. */
export class ConversationNotFoundError extends NotFoundError {
  constructor(id: string, options?: ErrorOptions) {
    super(`Conversation ${id} was not found`, options);
    this.name = 'ConversationNotFoundError';
  }
}

/** A contact the project doesn't have — NOT_FOUND. */
export class ContactNotFoundError extends NotFoundError {
  constructor(id: string, options?: ErrorOptions) {
    super(`Contact ${id} was not found`, options);
    this.name = 'ContactNotFoundError';
  }
}

/** A category the project doesn't offer — BAD_REQUEST. */
export class UnknownCategoryError extends BadRequestError {
  constructor(key: string, options?: ErrorOptions) {
    super(`"${key}" isn't one of this project's categories`, options);
    this.name = 'UnknownCategoryError';
  }
}

/** Attachments need object storage, and this deploy has none configured — BAD_REQUEST. */
export class AttachmentsUnavailableError extends BadRequestError {
  constructor(options?: ErrorOptions) {
    super("Attachments aren't available: object storage isn't configured", options);
    this.name = 'AttachmentsUnavailableError';
  }
}

/** An uploaded file's bytes aren't the type it was declared as — BAD_REQUEST. Its
 * bytes and the attachment are deleted. */
export class AttachmentContentMismatchError extends BadRequestError {
  constructor(declared: string, options?: ErrorOptions) {
    super(`The uploaded file is not ${declared}`, options);
    this.name = 'AttachmentContentMismatchError';
  }
}

/** An attachment id that isn't the user's, or is already in a message — BAD_REQUEST. */
export class AttachmentNotFoundError extends BadRequestError {
  constructor(options?: ErrorOptions) {
    super('An attachment was not uploaded by this user, or is already in a message', options);
    this.name = 'AttachmentNotFoundError';
  }
}

/** The project doesn't take messages from people who aren't signed in — FORBIDDEN. */
export class GuestsNotAllowedError extends ForbiddenError {
  constructor(options?: ErrorOptions) {
    super('This app only takes messages from signed-in users', options);
    this.name = 'GuestsNotAllowedError';
  }
}

/** Someone who isn't in the project's inbox rotation — NOT_FOUND. */
export class InboxMemberNotFoundError extends NotFoundError {
  constructor(userId: string, options?: ErrorOptions) {
    super(`${userId} isn't a member of this inbox`, options);
    this.name = 'InboxMemberNotFoundError';
  }
}

/** Only the workspace's members can take conversations — BAD_REQUEST. */
export class NotWorkspaceMemberError extends BadRequestError {
  constructor(userId: string, options?: ErrorOptions) {
    super(`${userId} isn't a member of this workspace`, options);
    this.name = 'NotWorkspaceMemberError';
  }
}
