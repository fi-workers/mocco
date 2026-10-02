import { AuditActions } from '@mocco/common/audit';
import { FlagEventTypes } from '@mocco/common/events';
import {
  CHANGESET_APPROVAL_TTL_MS,
  ChangeOutcomes,
  ChangesetSources,
  ChangesetStates,
  FlagApprovalSubjects,
} from '@mocco/common/flags';
import { ApprovalKinds } from '@mocco/common/governance';
import { z } from 'zod';

import { publishBestEffort } from '@backend/domain/events/ports';
import { changesetContentHash } from '@backend/domain/flags/apply-ops';
import { auditRestores } from '@backend/domain/flags/audit-restores';
import { changesetMessage } from '@backend/domain/flags/changeset-message';
import {
  ChangesetConflictError,
  ChangesetHashMismatchError,
  ChangesetNotFoundError,
  ChangesetNotPendingError,
  FlagEnvironmentNotFoundError,
  NotChangesetProposerError,
} from '@backend/domain/flags/errors';
import { FlagChangesetRepo } from '@backend/domain/flags/repos/flag-changeset.repo';
import { FlagEnvironmentRepo } from '@backend/domain/flags/repos/flag-environment.repo';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type { EventPublisher } from '@backend/domain/events/ports';
import type { FlagChangesetRow } from '@backend/domain/flags/repos/flag-changeset.repo';
import type { FlagEnvironmentRow } from '@backend/domain/flags/repos/flag-environment.repo';
import type { RulesetPublisher } from '@backend/domain/flags/RulesetPublisher';
import type { ApprovalRequestRow, ApprovalService } from '@backend/domain/governance/ApprovalService';
import type { Db } from '@backend/infra/db/types';
import type { ChangeOp } from '@mocco/common/flags';
import type { ApprovalDecision, GateRequirements } from '@mocco/common/governance';

export interface FlagGovernanceDeps {
  db: Db;
  audit: AuditService;
  approvals: ApprovalService;
  publisher: RulesetPublisher;
  /** Where approval requests and decisions are published; omitted in most tests. */
  events?: EventPublisher;
  /** The app origin, for links in notification messages. */
  appOrigin?: string;
  now?: () => Date;
}

/** What a changeset approval pins: the changeset and the exact content approvers saw. */
const changesetActionSchema = z.object({
  changesetId: z.uuid(),
  environmentId: z.uuid(),
  contentHash: z.string(),
  baseVersion: z.number().int(),
});

/** What a change-gate approval pins: the environment and its new gate (null: unprotect). */
const changeGateActionSchema = z.object({
  environmentId: z.uuid(),
  gate: z.custom<GateRequirements | null>(),
});

/** How many expired changesets one sweep resolves. */
const EXPIRY_BATCH = 100;

/**
 * Governed changes to protected environments (#141, ADRs 0020 and 0023). A change to an
 * environment with a `change_gate` is recorded as a pending changeset and becomes a
 * `pre_approval` under that gate, pinned to the changeset's content hash. Approval
 * applies it through the `RulesetPublisher` (or marks it `conflicted` when the
 * environment moved past its base version); rejection, withdrawal and expiry resolve it.
 * A rebase re-proposes the same ops on the current version: a new hash, so no earlier
 * vote carries over. Changing a protected environment's gate is itself a request under
 * the current gate, and in-flight changesets keep the gate they were proposed under.
 */
export class FlagGovernanceService {
  private readonly now: () => Date;

  constructor(private readonly deps: FlagGovernanceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private async notify(
    type: Exclude<(typeof FlagEventTypes)[keyof typeof FlagEventTypes], typeof FlagEventTypes.flagKilled>,
    environment: FlagEnvironmentRow,
    changeset: FlagChangesetRow,
  ): Promise<void> {
    const { events } = this.deps;
    if (events === undefined) {
      return;
    }
    await publishBestEffort(events, type, async () => ({
      type,
      workspaceId: environment.workspaceId,
      projectId: environment.projectId,
      subject: { type: 'flag_changeset', id: changeset.id },
      payload: {
        facts: { environment: environment.key, changeset: changeset.id },
        message: changesetMessage(
          type,
          {
            workspaceId: environment.workspaceId,
            projectId: environment.projectId,
            environment: { id: environment.id, name: environment.name },
            diff: changeset.diff,
            requestedBy:
              (await new FlagChangesetRepo(this.deps.db).proposerLabel(changeset.workspaceId, changeset.id)) ??
              'someone',
            reason: changeset.reason,
          },
          this.deps.appOrigin,
        ),
      },
    }));
  }

  private async audit(
    workspaceId: string,
    actorUserId: string | null,
    action: (typeof AuditActions)[keyof typeof AuditActions],
    changeset: FlagChangesetRow,
    extra: Record<string, unknown> = {},
  ) {
    await this.deps.audit.record(workspaceId, {
      actorUserId,
      action,
      subjectType: 'flag_environment',
      subjectId: changeset.environmentId,
      payload: {
        changesetId: changeset.id,
        contentHash: changeset.contentHash,
        baseVersion: changeset.baseVersion,
        approvalRequestId: changeset.approvalRequestId,
        ...extra,
      },
    });
  }

  private async close(
    changeset: FlagChangesetRow,
    state: typeof ChangesetStates.withdrawn | typeof ChangesetStates.superseded,
    action: (typeof AuditActions)[keyof typeof AuditActions],
    actorUserId: string,
  ) {
    const closed = await new FlagChangesetRepo(this.deps.db).resolvePending(
      changeset.workspaceId,
      changeset.id,
      state,
      {
        resolvedAt: this.now(),
      },
    );
    if (closed === undefined) {
      throw new ChangesetNotPendingError(changeset.id, changeset.state);
    }
    await this.deps.approvals.supersedePending(
      changeset.workspaceId,
      FlagApprovalSubjects.changeset,
      changeset.id,
      actorUserId,
    );
    await this.audit(changeset.workspaceId, actorUserId, action, closed);
    return closed;
  }

  private async writeGate(
    environment: FlagEnvironmentRow,
    gate: GateRequirements | null,
    actorUserId: string | null,
    approvalRequestId: string | null,
  ) {
    await new FlagEnvironmentRepo(this.deps.db).setChangeGate(environment.workspaceId, environment.id, gate);
    await this.deps.audit.record(environment.workspaceId, {
      actorUserId,
      action: AuditActions.flagChangeGateChanged,
      subjectType: 'flag_environment',
      subjectId: environment.id,
      payload: { before: environment.changeGate, after: gate, approvalRequestId },
    });
  }

  private async environmentOf(workspaceId: string, environmentId: string) {
    const environment = await new FlagEnvironmentRepo(this.deps.db).byId(workspaceId, environmentId);
    if (environment === undefined) {
      throw new FlagEnvironmentNotFoundError(environmentId);
    }
    return environment;
  }

  /** A pending changeset of the project, or throw. */
  async requireChangeset(workspaceId: string, projectId: string, changesetId: string) {
    const changeset = await new FlagChangesetRepo(this.deps.db).find(workspaceId, changesetId);
    if (changeset === undefined) {
      throw new ChangesetNotFoundError(changesetId);
    }
    const environment = await this.environmentOf(workspaceId, changeset.environmentId);
    if (environment.projectId !== projectId) {
      throw new ChangesetNotFoundError(changesetId);
    }
    return { changeset, environment };
  }

  /**
   * Propose `ops` to a protected environment: validate them against `baseVersion` now (so
   * a bad change is refused at once), record a pending changeset with the gate pinned,
   * and open the approval request.
   */
  async propose(
    environment: FlagEnvironmentRow & { changeGate: GateRequirements },
    actorUserId: string,
    input: { baseVersion: number; ops: readonly ChangeOp[]; reason: string | null },
  ) {
    const { workspaceId } = environment;
    if (input.baseVersion !== environment.currentVersion) {
      throw new ChangesetConflictError(environment.id, input.baseVersion, environment.currentVersion);
    }
    const diff = await this.deps.publisher.dryRun(this.deps.db, environment, input.ops);
    const expiresAt = new Date(this.now().getTime() + CHANGESET_APPROVAL_TTL_MS);
    const changesets = new FlagChangesetRepo(this.deps.db);
    const created = await changesets.insert({
      workspaceId,
      environmentId: environment.id,
      state: ChangesetStates.pending,
      source: ChangesetSources.ui,
      ops: [...input.ops],
      diff,
      contentHash: changesetContentHash(environment.id, input.baseVersion, input.ops),
      baseVersion: input.baseVersion,
      proposedByUserId: actorUserId,
      reason: input.reason,
      requirements: environment.changeGate,
      expiresAt,
    });
    const request = await this.deps.approvals.request(workspaceId, {
      kind: ApprovalKinds.preApproval,
      subjectType: FlagApprovalSubjects.changeset,
      subjectId: created.id,
      action: {
        changesetId: created.id,
        environmentId: environment.id,
        contentHash: created.contentHash,
        baseVersion: created.baseVersion,
      },
      requirements: environment.changeGate,
      requestedByUserId: actorUserId,
      expiresAt,
    });
    await changesets.setApprovalRequest(workspaceId, created.id, request.id);
    const changeset = { ...created, approvalRequestId: request.id };
    await this.audit(workspaceId, actorUserId, AuditActions.flagChangesetProposed, changeset, {
      diff,
      reason: input.reason,
    });
    await this.notify(FlagEventTypes.flagChangesetRequested, environment, changeset);
    return { outcome: ChangeOutcomes.pendingApproval, changeset };
  }

  /**
   * Vote on a pending changeset. `contentHash` is the hash the voter reviewed: a vote for
   * a different one (the changeset was replaced) is refused. An approval that satisfies
   * the gate applies the changeset (through the registered handler).
   */
  async vote(
    workspaceId: string,
    projectId: string,
    voterUserId: string,
    input: { changesetId: string; contentHash: string; decision: ApprovalDecision; reason?: string },
  ) {
    const { changeset } = await this.requireChangeset(workspaceId, projectId, input.changesetId);
    if (changeset.state !== ChangesetStates.pending || changeset.approvalRequestId === null) {
      throw new ChangesetNotPendingError(changeset.id, changeset.state);
    }
    if (changeset.contentHash !== input.contentHash) {
      throw new ChangesetHashMismatchError();
    }
    await this.deps.approvals.vote(workspaceId, changeset.approvalRequestId, voterUserId, input.decision, input.reason);
    const after = await this.requireChangeset(workspaceId, projectId, changeset.id);
    return after.changeset;
  }

  /** The approval handler for `flags.changeset`: apply the pinned changeset, or mark it
   * conflicted when the environment moved past its base version. */
  async applyApproved(request: ApprovalRequestRow): Promise<void> {
    const action = changesetActionSchema.parse(request.action);
    const { workspaceId } = request;
    const changesets = new FlagChangesetRepo(this.deps.db);
    const changeset = await changesets.find(workspaceId, action.changesetId);
    if (changeset?.state !== ChangesetStates.pending || changeset.contentHash !== action.contentHash) {
      return;
    }
    const environment = await this.environmentOf(workspaceId, changeset.environmentId);
    try {
      const result = await this.deps.db.transaction(
        async tx =>
          await this.deps.publisher.apply(tx, workspaceId, {
            environmentId: changeset.environmentId,
            baseVersion: changeset.baseVersion,
            ops: changeset.ops,
            source: changeset.source,
            actorUserId: changeset.proposedByUserId,
            reason: changeset.reason,
            pendingChangesetId: changeset.id,
          }),
      );
      const applied = result.changeset;
      await this.audit(workspaceId, changeset.proposedByUserId, AuditActions.flagChangesetApplied, applied, {
        version: applied.appliedVersion,
        source: applied.source,
        diff: applied.diff,
      });
      await auditRestores(this.deps.audit, workspaceId, changeset.proposedByUserId, applied);
      await this.notify(FlagEventTypes.flagChangesetApplied, environment, applied);
    } catch (error) {
      if (!(error instanceof ChangesetConflictError)) {
        throw error;
      }
      const conflicted = await changesets.resolvePending(workspaceId, changeset.id, ChangesetStates.conflicted, {
        resolvedAt: this.now(),
      });
      if (conflicted !== undefined) {
        await this.audit(workspaceId, null, AuditActions.flagChangesetConflicted, conflicted, {
          currentVersion: environment.currentVersion,
        });
      }
    }
  }

  /** The rejection listener for `flags.changeset`. */
  async markRejected(request: ApprovalRequestRow): Promise<void> {
    const action = changesetActionSchema.parse(request.action);
    const rejected = await new FlagChangesetRepo(this.deps.db).resolvePending(
      request.workspaceId,
      action.changesetId,
      ChangesetStates.rejected,
      { resolvedAt: this.now() },
    );
    if (rejected === undefined) {
      return;
    }
    await this.audit(request.workspaceId, null, AuditActions.flagChangesetRejected, rejected);
    const environment = await this.environmentOf(request.workspaceId, rejected.environmentId);
    await this.notify(FlagEventTypes.flagChangesetRejected, environment, rejected);
  }

  /** The proposer withdraws a pending changeset (its approval request is superseded). */
  async withdraw(workspaceId: string, projectId: string, actorUserId: string, changesetId: string) {
    const { changeset } = await this.requireChangeset(workspaceId, projectId, changesetId);
    if (changeset.proposedByUserId !== actorUserId) {
      throw new NotChangesetProposerError();
    }
    return await this.close(changeset, ChangesetStates.withdrawn, AuditActions.flagChangesetWithdrawn, actorUserId);
  }

  /**
   * Rebase a pending or conflicted changeset onto the environment's current version: the
   * same ops, proposed again under the environment's current gate. The new changeset has
   * a new content hash, so votes on the old one don't count.
   */
  async rebase(workspaceId: string, projectId: string, actorUserId: string, changesetId: string) {
    const { changeset } = await this.requireChangeset(workspaceId, projectId, changesetId);
    if (changeset.proposedByUserId !== actorUserId) {
      throw new NotChangesetProposerError();
    }
    if (changeset.state !== ChangesetStates.pending && changeset.state !== ChangesetStates.conflicted) {
      throw new ChangesetNotPendingError(changeset.id, changeset.state);
    }
    const environment = await this.environmentOf(workspaceId, changeset.environmentId);
    if (environment.changeGate === null) {
      throw new ChangesetNotPendingError(changeset.id, 'on an unprotected environment');
    }
    // Propose first: if the ops no longer apply, the old changeset stays as it was.
    const rebased = await this.propose({ ...environment, changeGate: environment.changeGate }, actorUserId, {
      baseVersion: environment.currentVersion,
      ops: changeset.ops,
      reason: changeset.reason,
    });
    if (changeset.state === ChangesetStates.pending) {
      await this.close(changeset, ChangesetStates.superseded, AuditActions.flagChangesetWithdrawn, actorUserId);
    }
    return rebased;
  }

  /** Expire pending changesets past their expiry (the `flags.changesets.expire` job). */
  async expireDue(): Promise<number> {
    const changesets = new FlagChangesetRepo(this.deps.db);
    const due = await changesets.listExpired(this.now(), EXPIRY_BATCH);
    const expired = await Promise.all(
      due.map(async changeset => {
        await this.deps.approvals.expireDue(changeset.workspaceId);
        const resolved = await changesets.resolvePending(changeset.workspaceId, changeset.id, ChangesetStates.expired, {
          resolvedAt: this.now(),
        });
        if (resolved !== undefined) {
          await this.audit(changeset.workspaceId, null, AuditActions.flagChangesetExpired, resolved);
        }
        return resolved;
      }),
    );
    return expired.filter(row => row !== undefined).length;
  }

  /**
   * Set or remove an environment's change gate. An unprotected environment is protected at
   * once; changing or removing the gate of a protected one is a request under its current
   * gate. In-flight changesets keep the gate they were proposed under.
   */
  async setChangeGate(
    workspaceId: string,
    projectId: string,
    actorUserId: string,
    input: { environmentId: string; gate: GateRequirements | null },
  ) {
    const environment = await this.environmentOf(workspaceId, input.environmentId);
    if (environment.projectId !== projectId) {
      throw new FlagEnvironmentNotFoundError(input.environmentId);
    }
    if (environment.changeGate === null) {
      await this.writeGate(environment, input.gate, actorUserId, null);
      return { outcome: ChangeOutcomes.applied, requestId: null };
    }
    await this.deps.approvals.supersedePending(
      workspaceId,
      FlagApprovalSubjects.changeGate,
      environment.id,
      actorUserId,
    );
    const request = await this.deps.approvals.request(workspaceId, {
      kind: ApprovalKinds.preApproval,
      subjectType: FlagApprovalSubjects.changeGate,
      subjectId: environment.id,
      action: { environmentId: environment.id, gate: input.gate },
      requirements: environment.changeGate,
      requestedByUserId: actorUserId,
    });
    return { outcome: ChangeOutcomes.pendingApproval, requestId: request.id };
  }

  /** The approval handler for `flags.change_gate`. */
  async applyApprovedGate(request: ApprovalRequestRow): Promise<void> {
    const action = changeGateActionSchema.parse(request.action);
    const environment = await this.environmentOf(request.workspaceId, action.environmentId);
    await this.writeGate(environment, action.gate, request.requestedByUserId, request.id);
  }
}
