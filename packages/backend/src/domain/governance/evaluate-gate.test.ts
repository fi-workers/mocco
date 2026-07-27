import { describe, it, expect } from 'vitest';

import { evaluateGate } from '@backend/domain/governance/evaluate-gate';

import type { GateRequirement, ResumeVote } from '@backend/domain/governance/evaluate-gate';

const resume = (principalId: string, role: string): ResumeVote => ({ principalId, role, decision: 'resume' });
const reject = (principalId: string, role: string): ResumeVote => ({ principalId, role, decision: 'reject' });

describe('evaluateGate', () => {
  describe('single-role N-of-M', () => {
    const reqs: GateRequirement[] = [{ role: 'reviewer', count: 2 }];

    it('is pending when under the required count', () => {
      expect(evaluateGate(reqs, [resume('alice', 'reviewer')])).toBe('pending');
    });

    it('is resumed when exactly at the required count', () => {
      expect(evaluateGate(reqs, [resume('alice', 'reviewer'), resume('bob', 'reviewer')])).toBe('resumed');
    });

    it('is resumed when over the required count', () => {
      expect(
        evaluateGate(reqs, [resume('alice', 'reviewer'), resume('bob', 'reviewer'), resume('carol', 'reviewer')]),
      ).toBe('resumed');
    });
  });

  describe('multi-role AND', () => {
    const reqs: GateRequirement[] = [
      { role: 'security', count: 1 },
      { role: 'ops', count: 1 },
    ];

    it('is resumed when every role requirement is met by distinct principals', () => {
      expect(evaluateGate(reqs, [resume('alice', 'security'), resume('bob', 'ops')])).toBe('resumed');
    });

    it('is pending when one role is still short', () => {
      expect(evaluateGate(reqs, [resume('alice', 'security'), resume('bob', 'security')])).toBe('pending');
    });
  });

  describe('distinct-principal bipartite matching', () => {
    // One human belongs to (and voted under) both required roles. They may fill
    // at most one slot — so a single person cannot cover both requirements.
    const reqs: GateRequirement[] = [
      { role: 'security', count: 1 },
      { role: 'ops', count: 1 },
    ];

    it('is pending when one person covers both required roles alone', () => {
      expect(evaluateGate(reqs, [resume('alice', 'security'), resume('alice', 'ops')])).toBe('pending');
    });

    it('is resumed once a second distinct person fills the other slot', () => {
      expect(evaluateGate(reqs, [resume('alice', 'security'), resume('alice', 'ops'), resume('bob', 'ops')])).toBe(
        'resumed',
      );
    });

    it('finds a matching that requires re-homing an over-qualified principal', () => {
      // alice can cover both roles; bob can only cover ops. A greedy per-role pass
      // could assign alice→ops and leave security unfilled; the augmenting path
      // re-homes alice to security so bob takes ops.
      const twoRoles: GateRequirement[] = [
        { role: 'security', count: 1 },
        { role: 'ops', count: 1 },
      ];
      expect(evaluateGate(twoRoles, [resume('alice', 'security'), resume('alice', 'ops'), resume('bob', 'ops')])).toBe(
        'resumed',
      );
    });
  });

  describe('reject wins', () => {
    it('is rejected when a reject vote exists even with enough resumes', () => {
      const reqs: GateRequirement[] = [{ role: 'reviewer', count: 1 }];
      expect(
        evaluateGate(reqs, [resume('alice', 'reviewer'), resume('bob', 'reviewer'), reject('carol', 'reviewer')]),
      ).toBe('rejected');
    });

    it('is rejected even with no requirements', () => {
      expect(evaluateGate([], [reject('alice', 'reviewer')])).toBe('rejected');
    });
  });

  describe('trivially-satisfied requirements', () => {
    it('is resumed for empty requirements (nothing required)', () => {
      expect(evaluateGate([], [])).toBe('resumed');
    });

    it('is resumed for a count:0 requirement with no votes', () => {
      expect(evaluateGate([{ role: 'reviewer', count: 0 }], [])).toBe('resumed');
    });

    it('is resumed when a count:0 requirement is mixed with a satisfied one', () => {
      const reqs: GateRequirement[] = [
        { role: 'reviewer', count: 0 },
        { role: 'ops', count: 1 },
      ];
      expect(evaluateGate(reqs, [resume('alice', 'ops')])).toBe('resumed');
    });
  });

  describe('duplicate-principal dedupe', () => {
    it('counts a principal voting twice under the same role only once', () => {
      const reqs: GateRequirement[] = [{ role: 'reviewer', count: 2 }];
      expect(evaluateGate(reqs, [resume('alice', 'reviewer'), resume('alice', 'reviewer')])).toBe('pending');
    });
  });
});
