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
import { EntityNotFoundError } from '@backend/infra/db/errors';

import type { RunEventRepo } from '@backend/domain/execution/repos/run-event.repo';
import type { RunRepo } from '@backend/domain/execution/repos/run.repo';
import type { ResumeVote } from '@backend/domain/governance/evaluate-gate';
import type { ResumeRepo } from '@backend/domain/governance/repos/resume.repo';
import type { RoleMembershipRepo } from '@backend/domain/governance/repos/role-membership.repo';
import type { RunGateRepo } from '@backend/domain/governance/repos/run-gate.repo';
import type { ResumeDecision } from '@mocco/common/governance';

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
}

/** Gate-related run events — the append-only progression log the timeline renders. */
const GateEventTypes = {
  gateResumed: 'gate.resumed',
  gateRejected: 'gate.rejected',
  runRejected: 'run.rejected',
} as const;

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

  /**
   * Build the evaluator input from ALL votes on a gate — the distinct-principal core.
   * For each vote look up the voter's role memberships, keep those the gate requires,
   * and emit one `resume` vote PER required role the voter holds (so the evaluator's
   * bipartite matching lets a two-role voter fill only one slot). A `reject` vote
   * emits a single vote (its role is irrelevant — a reject short-circuits).
   */
  private async buildVotes(workspaceId: string, gateId: string, requiredRoleNames: Set<string>): Promise<ResumeVote[]> {
    const resumes = await this.deps.resumes.listByRunGate(workspaceId, gateId);
    const perVote = await Promise.all(
      resumes.map(async resume => {
        const memberRoles = await this.deps.memberships.listRolesForUser(workspaceId, resume.userId);
        const roles = memberRoles.map(role => role.name).filter(name => requiredRoleNames.has(name));
        if (resume.decision === ResumeDecisions.reject) {
          const role = roles[0] ?? [...requiredRoleNames][0] ?? '';
          return [{ principalId: resume.userId, role, decision: ResumeDecisions.reject } satisfies ResumeVote];
        }
        return roles.map(
          role => ({ principalId: resume.userId, role, decision: ResumeDecisions.resume }) satisfies ResumeVote,
        );
      }),
    );
    return perVote.flat();
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

    // prevent_self (this slice = the triggerer only; the fuller identity set is
    // deferred, fail-closed). A run whose triggerer was cleared can't match here.
    if (requirements.prevent_self && userId === run.triggeredByUserId) {
      throw new PreventSelfError();
    }

    // The voter must be a member of at least one role the gate requires. The role the
    // vote counts under is recorded (nullable if that role is later deleted).
    const requiredRoleNames = new Set(requirements.resume.map(requirement => requirement.role));
    const memberRoles = await this.deps.memberships.listRolesForUser(workspaceId, userId);
    const votedRole = memberRoles.find(role => requiredRoleNames.has(role.name));
    if (votedRole === undefined) {
      throw new NotAuthorizedToResumeError();
    }

    // Normalize the reason once (empty/whitespace → absent) — the reason_required guard.
    const trimmed = reason?.trim();
    const normalizedReason = trimmed !== undefined && trimmed !== '' ? trimmed : undefined;
    if (requirements.reason_required && normalizedReason === undefined) {
      throw new ReasonRequiredError();
    }

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

    const outcome = evaluateGate(requirements.resume, await this.buildVotes(workspaceId, gate.id, requiredRoleNames));

    if (outcome === 'rejected') {
      await this.rejectRun(workspaceId, run, gate.id, gateItemIndex, gate.name);
    } else if (outcome === 'resumed') {
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
    }
    // `pending` → nothing; the gate waits for more votes.

    return await this.load(workspaceId, runId, gateItemIndex);
  }
}
