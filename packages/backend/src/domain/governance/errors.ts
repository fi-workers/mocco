import { BadRequestError, ForbiddenError, NotFoundError } from '@backend/domain/errors';

/** A role the caller's workspace doesn't own or that doesn't exist — NOT_FOUND. */
export class RoleNotFoundError extends NotFoundError {
  constructor(id: string, options?: ErrorOptions) {
    super(`Role ${id} was not found`, options);
    this.name = 'RoleNotFoundError';
  }
}

/** The gate the caller tried to resume isn't the run's current, pending, awaiting
 * gate (a foreign/unknown run, a run not paused here, or an already-resolved gate).
 * Surfaced as NOT_FOUND — the resource the request names isn't actionable. */
export class GateNotCurrentError extends NotFoundError {
  constructor(runId: string, gateItemIndex: number, options?: ErrorOptions) {
    super(`No pending gate at index ${gateItemIndex} for run ${runId}`, options);
    this.name = 'GateNotCurrentError';
  }
}

/** The gate sets `prevent_self` and the voter is the run's triggerer — BAD_REQUEST.
 * Fail-closed: the fuller identity set is deferred, so only the triggerer is checked. */
export class PreventSelfError extends BadRequestError {
  constructor(options?: ErrorOptions) {
    super('You cannot resume a gate on a run you triggered', options);
    this.name = 'PreventSelfError';
  }
}

/** The gate sets `reason_required` and the vote carried no reason — BAD_REQUEST. */
export class ReasonRequiredError extends BadRequestError {
  constructor(options?: ErrorOptions) {
    super('This gate requires a reason to resume', options);
    this.name = 'ReasonRequiredError';
  }
}

/** The voter has already cast a vote on this gate — BAD_REQUEST (one vote per person). */
export class DuplicateVoteError extends BadRequestError {
  constructor(options?: ErrorOptions) {
    super('You have already voted on this gate', options);
    this.name = 'DuplicateVoteError';
  }
}

/** The voter is not a member of any role the gate requires — FORBIDDEN. */
export class NotAuthorizedToResumeError extends ForbiddenError {
  constructor(options?: ErrorOptions) {
    super('You are not in a role authorized to resume this gate', options);
    this.name = 'NotAuthorizedToResumeError';
  }
}

/** An approval request the workspace doesn't own, or that doesn't exist — NOT_FOUND. */
export class ApprovalNotFoundError extends NotFoundError {
  constructor(id: string, options?: ErrorOptions) {
    super(`Approval request ${id} was not found`, options);
    this.name = 'ApprovalNotFoundError';
  }
}

/** The request is no longer collecting votes (approved, rejected, expired or superseded) — BAD_REQUEST. */
export class ApprovalNotPendingError extends BadRequestError {
  constructor(id: string, options?: ErrorOptions) {
    super(`Approval request ${id} is no longer pending`, options);
    this.name = 'ApprovalNotPendingError';
  }
}

/** `prevent_self` is set and the voter requested the change — BAD_REQUEST. */
export class SelfApprovalError extends BadRequestError {
  constructor(options?: ErrorOptions) {
    super('You cannot approve a change you requested', options);
    this.name = 'SelfApprovalError';
  }
}

/** The voter holds none of the roles the request requires — FORBIDDEN. */
export class NotAuthorizedToApproveError extends ForbiddenError {
  constructor(options?: ErrorOptions) {
    super('You are not in a role authorized to approve this change', options);
    this.name = 'NotAuthorizedToApproveError';
  }
}

/** The request sets `reason_required` and the vote carried no reason — BAD_REQUEST. */
export class ApprovalReasonRequiredError extends BadRequestError {
  constructor(options?: ErrorOptions) {
    super('This approval requires a reason', options);
    this.name = 'ApprovalReasonRequiredError';
  }
}

/** The voter already voted on this request — BAD_REQUEST (one vote per person). */
export class DuplicateApprovalVoteError extends BadRequestError {
  constructor(options?: ErrorOptions) {
    super('You have already voted on this approval', options);
    this.name = 'DuplicateApprovalVoteError';
  }
}
