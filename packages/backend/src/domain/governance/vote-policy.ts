import { ResumeDecisions } from '@mocco/common/governance';

import type { ResumeVote } from '@backend/domain/governance/evaluate-gate';
import type { GateRequirements } from '@mocco/common/governance';

/** A role the voter holds in the workspace. */
export interface MemberRole {
  roleId: string;
  name: string;
}

/** Why a vote is refused — each caller maps these to its own domain error, so a run
 * gate and an approval request word the refusal for their own subject. */
export const VoteDenials = {
  self: 'self',
  notAuthorized: 'not_authorized',
  reasonRequired: 'reason_required',
} as const;
export type VoteDenial = (typeof VoteDenials)[keyof typeof VoteDenials];

export interface VoteCheckInput {
  requirements: GateRequirements;
  voterUserId: string;
  /** Who triggered the run / requested the change — barred when `prevent_self` is set.
   * Null (the user was deleted) never matches, so the guard stays fail-closed. */
  subjectOwnerUserId: string | null;
  voterRoles: MemberRole[];
  reason?: string;
}

export type VoteCheck =
  { ok: true; votedRole: MemberRole; reason: string | undefined } | { ok: false; denial: VoteDenial };

/**
 * The voter guards shared by run gates and approval requests, in order:
 * `prevent_self` bars the subject's owner; the voter must hold at least one required
 * role (the first match is the role the vote counts under); `reason_required` needs a
 * non-blank reason. Pure — the callers fetch the roles and record the vote.
 *
 * sonarjs/function-return-type is a false positive here: every branch returns a member
 * of the single `VoteCheck` discriminated union.
 */
// eslint-disable-next-line sonarjs/function-return-type
export function checkVote(input: VoteCheckInput): VoteCheck {
  const { requirements, voterUserId, subjectOwnerUserId, voterRoles } = input;
  if (requirements.prevent_self && voterUserId === subjectOwnerUserId) {
    return { ok: false, denial: VoteDenials.self };
  }
  const requiredRoleNames = new Set(requirements.resume.map(requirement => requirement.role));
  const votedRole = voterRoles.find(role => requiredRoleNames.has(role.name));
  if (votedRole === undefined) {
    return { ok: false, denial: VoteDenials.notAuthorized };
  }
  const trimmed = input.reason?.trim();
  const reason = trimmed !== undefined && trimmed !== '' ? trimmed : undefined;
  if (requirements.reason_required && reason === undefined) {
    return { ok: false, denial: VoteDenials.reasonRequired };
  }
  return { ok: true, votedRole, reason };
}

/** A recorded vote, reduced to what the evaluator needs. `approves` is false for a reject. */
export interface CastVote {
  userId: string;
  approves: boolean;
  /** The voter's current roles in the workspace. */
  roles: MemberRole[];
}

/**
 * Build the evaluator input — the distinct-principal core. An approving vote emits one
 * `resume` vote PER required role the voter holds, so the evaluator's bipartite
 * matching lets a two-role voter fill only one slot. A rejecting vote emits a single
 * vote (its role is irrelevant — a reject short-circuits).
 */
export function toEvaluatorVotes(requirements: GateRequirements, votes: CastVote[]): ResumeVote[] {
  const requiredRoleNames = new Set(requirements.resume.map(requirement => requirement.role));
  return votes.flatMap((vote): ResumeVote[] => {
    const roles = vote.roles.map(role => role.name).filter(name => requiredRoleNames.has(name));
    if (!vote.approves) {
      const role = roles[0] ?? [...requiredRoleNames][0] ?? '';
      return [{ principalId: vote.userId, role, decision: ResumeDecisions.reject }];
    }
    return roles.map(role => ({ principalId: vote.userId, role, decision: ResumeDecisions.resume }));
  });
}
