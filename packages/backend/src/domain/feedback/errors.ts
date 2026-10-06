import { BadRequestError, ConflictError, NotFoundError } from '@backend/domain/errors';

import type { FeedbackPostStatus } from '@mocco/common/feedback';

/** A board the project doesn't have — NOT_FOUND. */
export class FeedbackBoardNotFoundError extends NotFoundError {
  constructor(boardId: string, options?: ErrorOptions) {
    super(`Feedback board ${boardId} was not found`, options);
    this.name = 'FeedbackBoardNotFoundError';
  }
}

/** A category that isn't on the board (or in the project) — NOT_FOUND. */
export class FeedbackCategoryNotFoundError extends NotFoundError {
  constructor(categoryId: string, options?: ErrorOptions) {
    super(`Feedback category ${categoryId} was not found`, options);
    this.name = 'FeedbackCategoryNotFoundError';
  }
}

/** A post the project doesn't have — NOT_FOUND. */
export class FeedbackPostNotFoundError extends NotFoundError {
  constructor(postId: string, options?: ErrorOptions) {
    super(`Feedback post ${postId} was not found`, options);
    this.name = 'FeedbackPostNotFoundError';
  }
}

/** The project already has a board, or the board a category, with the slug — CONFLICT. */
export class FeedbackSlugTakenError extends ConflictError {
  constructor(kind: 'board' | 'category', slug: string, options?: ErrorOptions) {
    super(`A ${kind} with the address "${slug}" already exists`, options);
    this.name = 'FeedbackSlugTakenError';
  }
}

/** Setting the status a post already has — CONFLICT (nothing would change, so no history row). */
export class FeedbackStatusUnchangedError extends ConflictError {
  constructor(status: FeedbackPostStatus, options?: ErrorOptions) {
    super(`The post is already ${status}`, options);
    this.name = 'FeedbackStatusUnchangedError';
  }
}

/** Confirming a vote the end user doesn't have on the post — NOT_FOUND. */
export class FeedbackVoteNotFoundError extends NotFoundError {
  constructor(postId: string, options?: ErrorOptions) {
    super(`The end user has no vote on feedback post ${postId}`, options);
    this.name = 'FeedbackVoteNotFoundError';
  }
}

/** A comment that is both the official response (public) and an internal note — BAD_REQUEST. */
export class FeedbackOfficialInternalError extends BadRequestError {
  constructor(options?: ErrorOptions) {
    super('An official response is public, so it cannot be internal', options);
    this.name = 'FeedbackOfficialInternalError';
  }
}
