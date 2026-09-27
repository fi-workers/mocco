import { describe, expect, it } from 'vitest';

import { checkVote, toEvaluatorVotes, VoteDenials } from '@backend/domain/governance/vote-policy';

import type { GateRequirements } from '@mocco/common/governance';

const requirements = (overrides: Partial<GateRequirements> = {}): GateRequirements => ({
  resume: [
    { role: 'release', count: 1 },
    { role: 'security', count: 1 },
  ],
  prevent_self: true,
  reason_required: false,
  ...overrides,
});
const release = { roleId: 'r1', name: 'release' };
const security = { roleId: 'r2', name: 'security' };
const viewer = { roleId: 'r3', name: 'viewer' };

describe('checkVote', () => {
  it('bars the subject owner under prevent_self', () => {
    expect(
      checkVote({ requirements: requirements(), voterUserId: 'u1', subjectOwnerUserId: 'u1', voterRoles: [release] }),
    ).toEqual({ ok: false, denial: VoteDenials.self });
  });

  it('lets the owner vote when prevent_self is off, and never matches a deleted owner', () => {
    expect(
      checkVote({
        requirements: requirements({ prevent_self: false }),
        voterUserId: 'u1',
        subjectOwnerUserId: 'u1',
        voterRoles: [release],
      }).ok,
    ).toBe(true);
    expect(
      checkVote({ requirements: requirements(), voterUserId: 'u1', subjectOwnerUserId: null, voterRoles: [release] })
        .ok,
    ).toBe(true);
  });

  it('requires one of the required roles and records the first match', () => {
    expect(
      checkVote({ requirements: requirements(), voterUserId: 'u2', subjectOwnerUserId: 'u1', voterRoles: [viewer] }),
    ).toEqual({ ok: false, denial: VoteDenials.notAuthorized });
    expect(
      checkVote({
        requirements: requirements(),
        voterUserId: 'u2',
        subjectOwnerUserId: 'u1',
        voterRoles: [viewer, security, release],
      }),
    ).toEqual({ ok: true, votedRole: security, reason: undefined });
  });

  it('requires a non-blank reason when reason_required, and trims it', () => {
    const strict = requirements({ reason_required: true });
    expect(
      checkVote({
        requirements: strict,
        voterUserId: 'u2',
        subjectOwnerUserId: 'u1',
        voterRoles: [release],
        reason: '  ',
      }),
    ).toEqual({ ok: false, denial: VoteDenials.reasonRequired });
    expect(
      checkVote({
        requirements: strict,
        voterUserId: 'u2',
        subjectOwnerUserId: 'u1',
        voterRoles: [release],
        reason: ' hotfix ',
      }),
    ).toEqual({ ok: true, votedRole: release, reason: 'hotfix' });
  });
});

describe('toEvaluatorVotes', () => {
  it('emits one resume vote per required role an approver holds, ignoring other roles', () => {
    expect(
      toEvaluatorVotes(requirements(), [{ userId: 'u2', approves: true, roles: [release, security, viewer] }]),
    ).toEqual([
      { principalId: 'u2', role: 'release', decision: 'resume' },
      { principalId: 'u2', role: 'security', decision: 'resume' },
    ]);
  });

  it('emits a single reject vote for a rejecting voter', () => {
    expect(toEvaluatorVotes(requirements(), [{ userId: 'u2', approves: false, roles: [release, security] }])).toEqual([
      { principalId: 'u2', role: 'release', decision: 'reject' },
    ]);
  });
});
