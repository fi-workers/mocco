import { AuditActions } from '@mocco/common/audit';
import { RunStates } from '@mocco/common/execution';
import { GateStates, ResumeDecisions } from '@mocco/common/governance';

import {
  DuplicateVoteError,
  GateNotCurrentError,
  NotAuthorizedToResumeError,
  PreventSelfError,
  ReasonRequiredError,
} from '@backend/domain/governance/errors';
import { evaluateGate } from '@backend/domain/governance/evaluate-gate';
import { checkVote, toEvaluatorVotes, VoteDenials } from '@backend/domain/governance/vote-policy';
import { EntityNotFoundError } from '@backend/infra/db/errors';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type { RunEventRepo } from '@backend/domain/execution/repos/run-event.repo';
import type { RunRepo } from '@backend/domain/execution/repos/run.repo';
import type { ResumeRepo } from '@backend/domain/governance/repos/resume.repo';
import type { RoleMembershipRepo } from '@backend/domain/governance/repos/role-membership.repo';
import type { RunGateRepo } from '@backend/domain/governance/repos/run-gate.repo';
import type { VoteDenial } from '@backend/domain/governance/vote-policy';
import type { GateRequirements, ResumeDecision } from '@mocco/common/governance';

/** Advance a run past a satisfied gate — the narrow slice of `RunService` the gate
 * service drives (injected as a callback to keep composition acyclic). */
export type ResumeRun = (run: { id: string; workspaceId: string }, gateItemIndex: number) => Promise<void>;

export interface GateServiceDeps {
  runs: RunRepo;
  runGates: RunGateRepo;
  resumes: ResumeRepo;
  memberships: RoleMembershipRepo;
  events: RunEventRepo;
  /** RunService.resumeFromGate — continues a run once its current gate is resumed. */
  resumeRun: ResumeRun;
  /** The append-only audit chain (slice 8). A gate outcome appends `gate.resumed` /
   * `gate.rejected` here; the append is fail-open (AuditService.record swallows +
   * logs), so an audit failure never breaks the resume/reject the caller drove. */
  audit: AuditService;
}

/** Gate-related run events — the append-only progression log the timeline renders. */
const GateEventTypes = {
  gateResumed: 'gate.resumed',
  gateRejected: 'gate.rejected',
  runRejected: 'run.rejected',
} as const;

/** The gate-worded domain error for a refused vote. */
function gateVoteError(denial: VoteDenial): Error {
  if (denial === VoteDenials.self) {
    return new PreventSelfError();
  }
  if (denial === VoteDenials.notAuthorized) {
    return new NotAuthorizedToResumeError();
  }
  return new ReasonRequiredError();
}

/**
 * Owns gate-resume policy: a paused run's current gate collects votes under N-of-M
 * AND role requirements, `prevent_self`, and `reason_required`. Anemic (ADR 0013) —
 * the N-of-M distinct-principal invariant lives in the pure `evaluateGate`; this
 * service applies the surrounding policy, records the vote, and drives the outcome.
 * Reaches the DB only through repos; workspace-scoped throughout (the router asserts
 * the caller is a member before delegating here).
 */
export class GateService {
  constructor(private readonly deps: GateServiceDeps) {}

  /** The run owned by the workspace, or GateNotCurrentError (never resolved by id
   * alone — always through the workspace-scoped repo). */
  private async requireRun(workspaceId: string, runId: string, gateItemIndex: number) {
    try {
      return await this.deps.runs.getByIdInWorkspace(workspaceId, runId);
    } catch (error) {
      if (error instanceof EntityNotFoundError) {
        throw new GateNotCurrentError(runId, gateItemIndex, { cause: error });
      }
      throw error;
    }
  }

  /** Halt the run: settle the gate rejected and mark the run rejected (terminal). */
  private async rejectRun(
    workspaceId: string,
    run: { id: string },
    gateId: string,
    gateItemIndex: number,
    gateName: string,
  ): Promise<void> {
    await this.deps.runGates.updateState(workspaceId, gateId, {
      state: GateStates.rejected,
      resolvedAt: new Date(),
    });
    await this.deps.runs.update(workspaceId, run.id, { state: RunStates.rejected, finishedAt: new Date() });
    await this.deps.events.append({
      workspaceId,
      runId: run.id,
      type: GateEventTypes.gateRejected,
      payload: { itemIndex: gateItemIndex, name: gateName },
    });
    await this.deps.events.append({ workspaceId, runId: run.id, type: GateEventTypes.runRejected, payload: {} });
  }

  /** Build the evaluator input from ALL votes on a gate (the distinct-principal core
   * lives in the shared `toEvaluatorVotes`). */
  private async buildVotes(workspaceId: string, gateId: string, requirements: GateRequirements) {
    const resumes = await this.deps.resumes.listByRunGate(workspaceId, gateId);
    const votes = await Promise.all(
      resumes.map(async resume => ({
        userId: resume.userId,
        approves: resume.decision === ResumeDecisions.resume,
        roles: await this.deps.memberships.listRolesForUser(workspaceId, resume.userId),
      })),
    );
    return toEvaluatorVotes(requirements, votes);
  }

  /** The run + its current gate after a vote — the mutation's return payload. */
  private async load(workspaceId: string, runId: string, gateItemIndex: number) {
    const run = await this.requireRun(workspaceId, runId, gateItemIndex);
    const gate = await this.deps.runGates.findByRunAndIndex(runId, gateItemIndex);
    if (gate === undefined) {
      throw new GateNotCurrentError(runId, gateItemIndex);
    }
    return { run, gate };
  }

  /**
   * Cast a vote on the run's current gate and drive the outcome.
   *
   * Guards, in order (each fail-closed): the gate must be the run's current pending
   * gate (`awaiting_gate` && `current_index === gateItemIndex`); `prevent_self` bars
   * the run's triggerer; the voter must be in a required role; `reason_required`
   * needs a reason; one vote per person. Then re-evaluates: `rejected` halts the run,
   * `resumed` continues it (past the gate), `pending` waits for more votes.
   */
  async resume(
    workspaceId: string,
    runId: string,
    gateItemIndex: number,
    userId: string,
    decision: ResumeDecision,
    reason?: string,
  ) {
    const run = await this.requireRun(workspaceId, runId, gateItemIndex);
    // The gate must be the exact one the run is paused at — a not-current/foreign gate
    // is not actionable (NOT_FOUND).
    if (run.state !== RunStates.awaitingGate || run.currentIndex !== gateItemIndex) {
      throw new GateNotCurrentError(runId, gateItemIndex);
    }
    const gate = await this.deps.runGates.findByRunAndIndex(runId, gateItemIndex);
    if (gate === undefined || gate.state !== GateStates.pending) {
      throw new GateNotCurrentError(runId, gateItemIndex);
    }
    const { requirements } = gate;

    // The shared voter guards (prevent_self against the run's triggerer — the fuller
    // identity set is deferred, fail-closed; required-role membership; reason_required).
    const memberRoles = await this.deps.memberships.listRolesForUser(workspaceId, userId);
    const check = checkVote({
      requirements,
      voterUserId: userId,
      subjectOwnerUserId: run.triggeredByUserId,
      voterRoles: memberRoles,
      reason,
    });
    if (!check.ok) {
      throw gateVoteError(check.denial);
    }
    const { votedRole, reason: normalizedReason } = check;

    // One vote per person per gate. The DB unique constraint backstops a race.
    const existing = await this.deps.resumes.findByGateAndUser(workspaceId, gate.id, userId);
    if (existing !== undefined) {
      throw new DuplicateVoteError();
    }
    await this.deps.resumes.insert({
      workspaceId,
      runGateId: gate.id,
      runId,
      userId,
      roleId: votedRole.roleId,
      decision,
      reason: normalizedReason ?? null,
    });

    const votes = await this.buildVotes(workspaceId, gate.id, requirements);
    const outcome = evaluateGate(requirements.resume, votes);

    if (outcome === GateStates.rejected) {
      await this.rejectRun(workspaceId, run, gate.id, gateItemIndex, gate.name);
      // Audit AFTER the run is durably halted — fail-open (never breaks the reject).
      // The actor is the rejecting voter; a reject short-circuits so it is decisive.
      await this.deps.audit.record(workspaceId, {
        actorUserId: userId,
        action: AuditActions.gateRejected,
        subjectType: 'run_gate',
        subjectId: gate.id,
        payload: { runId, gateName: gate.name, itemIndex: gateItemIndex, reason: normalizedReason ?? null },
      });
    } else if (outcome === GateStates.resumed) {
      await this.deps.runGates.updateState(workspaceId, gate.id, {
        state: GateStates.resumed,
        resolvedAt: new Date(),
      });
      await this.deps.events.append({
        workspaceId,
        runId,
        type: GateEventTypes.gateResumed,
        payload: { itemIndex: gateItemIndex, name: gate.name },
      });
      // Continue the run from past the gate (dispatch the next item, pause at the
      // next gate, or finish) — the injected RunService slice.
      await this.deps.resumeRun(run, gateItemIndex);
      // Audit AFTER the run is durably advanced — fail-open. Records the resuming
      // principals + the role each vote counted under (ADR 0010, as-of-resume).
      await this.deps.audit.record(workspaceId, {
        actorUserId: userId,
        action: AuditActions.gateResumed,
        subjectType: 'run_gate',
        subjectId: gate.id,
        payload: {
          runId,
          gateName: gate.name,
          itemIndex: gateItemIndex,
          principals: votes
            .filter(vote => vote.decision === ResumeDecisions.resume)
            .map(vote => ({ userId: vote.principalId, role: vote.role })),
        },
      });
    }
    // `pending` → nothing; the gate waits for more votes.

    return await this.load(workspaceId, runId, gateItemIndex);
  }
}
