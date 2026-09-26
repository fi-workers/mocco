import { AuditActions } from '@mocco/common/audit';
import { ApprovalDecisions, ApprovalKinds, ApprovalStates, GateStates } from '@mocco/common/governance';

import {
  ApprovalNotFoundError,
  ApprovalNotPendingError,
  ApprovalReasonRequiredError,
  DuplicateApprovalVoteError,
  NotAuthorizedToApproveError,
  SelfApprovalError,
} from '@backend/domain/governance/errors';
import { evaluateGate } from '@backend/domain/governance/evaluate-gate';
import { checkVote, toEvaluatorVotes, VoteDenials } from '@backend/domain/governance/vote-policy';
import { EntityNotFoundError } from '@backend/infra/db/errors';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type {
  ApprovalRequestFilter,
  ApprovalRequestRepo,
} from '@backend/domain/governance/repos/approval-request.repo';
import type { ApprovalVoteRepo } from '@backend/domain/governance/repos/approval-vote.repo';
import type { RoleMembershipRepo } from '@backend/domain/governance/repos/role-membership.repo';
import type { VoteDenial } from '@backend/domain/governance/vote-policy';
import type { ApprovalDecision, ApprovalKind, ApprovalState, GateRequirements } from '@mocco/common/governance';

/** The request row as the repos return it. */
export type ApprovalRequestRow = Awaited<ReturnType<ApprovalRequestRepo['getByIdInWorkspace']>>;

/** Applies an approved `pre_approval` request's pinned action. One per `subject_type`,
 * bound at the composition root. It must be idempotent: it runs at most once per
 * request, but a failed apply may be retried by the owning domain. */
export type ApprovalHandler = (request: ApprovalRequestRow) => Promise<void>;

export interface ApprovalServiceDeps {
  requests: ApprovalRequestRepo;
  votes: ApprovalVoteRepo;
  memberships: RoleMembershipRepo;
  audit: AuditService;
  /** `subject_type` → handler, bound at construction; product composition roots add
   * theirs with `registerHandler`. */
  handlers?: ReadonlyMap<string, ApprovalHandler>;
  now?: () => Date;
}

export interface ApprovalRequestInput {
  kind: ApprovalKind;
  subjectType: string;
  subjectId: string;
  action: Record<string, unknown>;
  requirements: GateRequirements;
  requestedByUserId: string | null;
  expiresAt?: Date | null;
}

/** The approval-worded domain error for a refused vote. */
function approvalVoteError(denial: VoteDenial): Error {
  if (denial === VoteDenials.self) {
    return new SelfApprovalError();
  }
  if (denial === VoteDenials.notAuthorized) {
    return new NotAuthorizedToApproveError();
  }
  return new ApprovalReasonRequiredError();
}

/**
 * Approvals outside runs (#114): any domain asks "may this pinned change happen?"
 * under the same `GateRequirements` a run gate uses, and the same voter guards
 * (`vote-policy.ts`) and pure N-of-M evaluator (`evaluateGate`) decide it. A
 * `pre_approval` request's handler applies the change once it is approved; a `review`
 * request records the post-hoc review of a change already applied. Anemic (ADR 0012):
 * the DB only through repos, workspace-scoped throughout.
 */
export class ApprovalService {
  private readonly handlers: Map<string, ApprovalHandler>;

  constructor(private readonly deps: ApprovalServiceDeps) {
    this.handlers = new Map(deps.handlers);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private async requireRequest(workspaceId: string, requestId: string) {
    try {
      return await this.deps.requests.getByIdInWorkspace(workspaceId, requestId);
    } catch (error) {
      if (error instanceof EntityNotFoundError) {
        throw new ApprovalNotFoundError(requestId, { cause: error });
      }
      throw error;
    }
  }

  /** Resolve out of `pending` and audit it; undefined when another writer won the race. */
  private async resolve(
    request: ApprovalRequestRow,
    state: ApprovalState,
    action: (typeof AuditActions)[keyof typeof AuditActions],
    actorUserId: string | null,
    payload: Record<string, unknown> = {},
  ) {
    const resolved = await this.deps.requests.resolveIfPending(request.workspaceId, request.id, state);
    if (resolved !== undefined) {
      await this.deps.audit.record(request.workspaceId, {
        actorUserId,
        action,
        subjectType: 'approval_request',
        subjectId: request.id,
        payload: { kind: request.kind, subjectType: request.subjectType, subjectId: request.subjectId, ...payload },
      });
    }
    return resolved;
  }

  /** Bind the handler that applies approved `pre_approval` requests of a subject type.
   * Called once by the owning product's composition root (ota → governance, never the
   * reverse), so governance stays free of product imports. */
  registerHandler(subjectType: string, handler: ApprovalHandler): void {
    if (this.handlers.has(subjectType)) {
      throw new Error(`An approval handler for ${subjectType} is already registered`);
    }
    this.handlers.set(subjectType, handler);
  }

  /** Open a request. Requirements are pinned here; a later policy edit never rewrites it. */
  async request(workspaceId: string, input: ApprovalRequestInput) {
    const created = await this.deps.requests.create({
      workspaceId,
      kind: input.kind,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      action: input.action,
      requirements: input.requirements,
      requestedByUserId: input.requestedByUserId,
      expiresAt: input.expiresAt ?? null,
    });
    await this.deps.audit.record(workspaceId, {
      actorUserId: input.requestedByUserId,
      action: AuditActions.approvalRequested,
      subjectType: 'approval_request',
      subjectId: created.id,
      payload: { kind: input.kind, subjectType: input.subjectType, subjectId: input.subjectId, action: input.action },
    });
    return created;
  }

  /** A request with its votes. Throws ApprovalNotFoundError for a foreign or unknown id. */
  async get(workspaceId: string, requestId: string) {
    const request = await this.requireRequest(workspaceId, requestId);
    const votes = await this.deps.votes.listByRequest(workspaceId, requestId);
    return { request, votes };
  }

  /** The workspace's requests, newest first. */
  async list(workspaceId: string, filter: ApprovalRequestFilter = {}) {
    return await this.deps.requests.list(workspaceId, filter);
  }

  /**
   * Cast a vote and drive the outcome. Guards, in order (each fail-closed): the request
   * is pending and not past its expiry (an expired one is marked expired first); the
   * shared voter guards; one vote per person. Then re-evaluates: a reject resolves it
   * `rejected`; a satisfied N-of-M resolves it `approved` and — for a `pre_approval`
   * — runs its subject's handler exactly once.
   */
  async vote(workspaceId: string, requestId: string, userId: string, decision: ApprovalDecision, reason?: string) {
    const request = await this.requireRequest(workspaceId, requestId);
    if (request.state !== ApprovalStates.pending) {
      throw new ApprovalNotPendingError(requestId);
    }
    // Fail-closed: a pre-approval nobody can apply must never be approved silently.
    const handler = this.handlers.get(request.subjectType);
    if (request.kind === ApprovalKinds.preApproval && handler === undefined) {
      throw new Error(`No approval handler is registered for ${request.subjectType}`);
    }
    if (request.expiresAt !== null && request.expiresAt <= this.now()) {
      await this.resolve(request, ApprovalStates.expired, AuditActions.approvalExpired, null);
      throw new ApprovalNotPendingError(requestId);
    }

    const voterRoles = await this.deps.memberships.listRolesForUser(workspaceId, userId);
    const check = checkVote({
      requirements: request.requirements,
      voterUserId: userId,
      subjectOwnerUserId: request.requestedByUserId,
      voterRoles,
      reason,
    });
    if (!check.ok) {
      throw approvalVoteError(check.denial);
    }
    if ((await this.deps.votes.findByRequestAndUser(workspaceId, requestId, userId)) !== undefined) {
      throw new DuplicateApprovalVoteError();
    }
    await this.deps.votes.insert({
      workspaceId,
      requestId,
      userId,
      roleId: check.votedRole.roleId,
      decision,
      reason: check.reason ?? null,
    });

    const recorded = await this.deps.votes.listByRequest(workspaceId, requestId);
    const votes = toEvaluatorVotes(
      request.requirements,
      await Promise.all(
        recorded.map(async vote => ({
          userId: vote.userId,
          approves: vote.decision === ApprovalDecisions.approve,
          roles: await this.deps.memberships.listRolesForUser(workspaceId, vote.userId),
        })),
      ),
    );
    const outcome = evaluateGate(request.requirements.resume, votes);

    if (outcome === GateStates.rejected) {
      await this.resolve(request, ApprovalStates.rejected, AuditActions.approvalRejected, userId, {
        reason: check.reason ?? null,
      });
    } else if (outcome === GateStates.resumed) {
      const approved = await this.resolve(request, ApprovalStates.approved, AuditActions.approvalApproved, userId, {
        principals: votes
          .filter(vote => vote.decision !== ApprovalDecisions.reject)
          .map(vote => ({
            userId: vote.principalId,
            role: vote.role,
          })),
      });
      if (approved !== undefined && request.kind === ApprovalKinds.preApproval && handler !== undefined) {
        await handler(approved);
      }
    }
    return await this.get(workspaceId, requestId);
  }

  /** Supersede every pending pre-approval for a subject (a newer change replaces them);
   * pending reviews are left alone. Returns how many. */
  async supersedePending(workspaceId: string, subjectType: string, subjectId: string, actorUserId: string | null) {
    const pending = await this.deps.requests.listPendingPreApprovalsForSubject(workspaceId, subjectType, subjectId);
    const resolved = await Promise.all(
      pending.map(
        async request =>
          await this.resolve(request, ApprovalStates.superseded, AuditActions.approvalSuperseded, actorUserId),
      ),
    );
    return resolved.filter(row => row !== undefined).length;
  }

  /** Expire every pending request past its expiry (driven by the job queue once it exists). Returns how many. */
  async expireDue(workspaceId: string) {
    const due = await this.deps.requests.listExpired(workspaceId, this.now());
    const resolved = await Promise.all(
      due.map(async request => await this.resolve(request, ApprovalStates.expired, AuditActions.approvalExpired, null)),
    );
    return resolved.filter(row => row !== undefined).length;
  }
}
