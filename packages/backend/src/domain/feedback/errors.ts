import { BadRequestError, ConflictError, NotFoundError } from '@backend/domain/errors';

import type { ChangelogEntryState, FeedbackPostStatus } from '@mocco/common/feedback';

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
  constructor(kind: 'board' | 'category' | 'changelog entry', slug: string, options?: ErrorOptions) {
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

/** The post left the status a change was asked from before it applied (a confirmation answered
 * after someone else moved the post) — CONFLICT, and nothing is written. */
export class FeedbackStatusMovedError extends ConflictError {
  constructor(expected: FeedbackPostStatus, current: FeedbackPostStatus, options?: ErrorOptions) {
    super(`The post is ${current} now, not ${expected}`, options);
    this.name = 'FeedbackStatusMovedError';
  }
}

/** A post that was merged into another: it can't be merged, merged into, voted on or followed
 * any more — CONFLICT. `intoPostId` is where its votes went. */
export class FeedbackPostMergedError extends ConflictError {
  constructor(
    postId: string,
    readonly intoPostId: string,
    options?: ErrorOptions,
  ) {
    super(`Feedback post ${postId} was merged into ${intoPostId}`, options);
    this.name = 'FeedbackPostMergedError';
  }
}

/** Merging a post into itself or into a post on another board — BAD_REQUEST. */
export class FeedbackMergeInvalidError extends BadRequestError {
  constructor(reason: 'same_post' | 'other_board', options?: ErrorOptions) {
    super(
      reason === 'same_post' ? 'A post cannot be merged into itself' : 'Posts can only be merged on the same board',
      options,
    );
    this.name = 'FeedbackMergeInvalidError';
  }
}

/** Confirming a vote the end user doesn't have on the post — NOT_FOUND. */
export class FeedbackVoteNotFoundError extends NotFoundError {
  constructor(postId: string, options?: ErrorOptions) {
    super(`The end user has no vote on feedback post ${postId}`, options);
    this.name = 'FeedbackVoteNotFoundError';
  }
}

/** A feedback mail link that is malformed, edited, expired or for another purpose — BAD_REQUEST. */
export class FeedbackLinkInvalidError extends BadRequestError {
  constructor(options?: ErrorOptions) {
    super('The link is not valid', options);
    this.name = 'FeedbackLinkInvalidError';
  }
}

/** This server sends no email, or the mail couldn't be handed over. */
export class FeedbackMailUnavailableError extends Error {
  constructor(reason: string, options?: ErrorOptions) {
    super(`Feedback mail could not be sent: ${reason}`, options);
    this.name = 'FeedbackMailUnavailableError';
  }
}

/** A comment that is both the official response (public) and an internal note — BAD_REQUEST. */
export class FeedbackOfficialInternalError extends BadRequestError {
  constructor(options?: ErrorOptions) {
    super('An official response is public, so it cannot be internal', options);
    this.name = 'FeedbackOfficialInternalError';
  }
}

/** A changelog entry the project doesn't have — NOT_FOUND. */
export class ChangelogEntryNotFoundError extends NotFoundError {
  constructor(entryId: string, options?: ErrorOptions) {
    super(`Changelog entry ${entryId} was not found`, options);
    this.name = 'ChangelogEntryNotFoundError';
  }
}

/** A change the entry's state doesn't allow (publishing a published entry, unpublishing a
 * draft) — CONFLICT, and nothing is written. */
export class ChangelogEntryStateError extends ConflictError {
  constructor(state: ChangelogEntryState, action: 'publish' | 'schedule' | 'unpublish', options?: ErrorOptions) {
    const verb = { publish: 'be published', schedule: 'be scheduled', unpublish: 'be unpublished' }[action];
    super(`A ${state} changelog entry can't ${verb}`, options);
    this.name = 'ChangelogEntryStateError';
  }
}

/** Scheduling an entry for a time that has passed — BAD_REQUEST (publish it instead). */
export class ChangelogPublishAtPastError extends BadRequestError {
  constructor(options?: ErrorOptions) {
    super('The publish time has passed; publish the entry now instead', options);
    this.name = 'ChangelogPublishAtPastError';
  }
}

/** An entry announcing a post that isn't a live post of its board (another board's, a merged
 * duplicate, or missing) — BAD_REQUEST. */
export class ChangelogPostsInvalidError extends BadRequestError {
  constructor(postIds: readonly string[], options?: ErrorOptions) {
    super(`These posts aren't live posts of the entry's board: ${postIds.join(', ')}`, options);
    this.name = 'ChangelogPostsInvalidError';
  }
}

/** The scope has no open duplicate pair with this id (it may have been dismissed) — NOT_FOUND. */
export class FeedbackDuplicateNotFoundError extends NotFoundError {
  constructor(id: string, options?: ErrorOptions) {
    super(`Open duplicate pair ${id} was not found`, options);
    this.name = 'FeedbackDuplicateNotFoundError';
  }
}
