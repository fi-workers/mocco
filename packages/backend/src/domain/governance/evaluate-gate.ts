import { GateStates, ResumeDecisions } from '@mocco/common/governance';

import type { ResumeDecision } from '@mocco/common/governance';

/** One required N-of-M slot on a gate: `count` distinct principals holding `role`
 * must resume for this requirement to be met. Kept plain and self-contained (NOT
 * derived from `moccoConfigSchema`) so the config schema can evolve independently
 * of this pure invariant. */
export interface GateRequirement {
  role: string;
  count: number;
}

/** A single recorded vote on a gate. `principalId` is the voting user; `role` is
 * the required role they voted under. The service records only *valid* votes (it
 * has already applied prevent_self / role-membership / reason_required policy). */
export interface ResumeVote {
  principalId: string;
  role: string;
  decision: ResumeDecision;
}

/** The evaluator's verdict — a subset of `GateStates` (never `expired`, a time-based
 * transition, not a vote outcome). Values sourced from the `GateStates` SSOT. */
export type GateOutcome = typeof GateStates.pending | typeof GateStates.resumed | typeof GateStates.rejected;

/**
 * Evaluate a gate's outcome from its snapshotted requirements and the votes cast.
 * Pure, exhaustively unit-tested — the **ADR-0013 SSOT** for the N-of-M gate
 * invariant (see the slice-5 gates spec §6; ADR-0013 resolves the gate as an
 * anemic service + this pure evaluator, not a rich aggregate).
 *
 * Rules:
 * - Any `reject` vote wins immediately → `'rejected'` (a rejection halts the run,
 *   ADR 0010 "terminal outcomes are declared").
 * - Otherwise the gate is satisfied by **N-of-M AND across roles counting DISTINCT
 *   principals** (ADR 0010): one human fills at most one required slot even when
 *   they voted under — or belong to — multiple required roles. A naive per-role
 *   count would let a single person in two roles cover two slots, silently
 *   weakening the guard; so this is a maximum **bipartite matching** between the
 *   role-slots (each requirement expands to `count` slots) and the resuming
 *   principals. `'resumed'` iff a matching fills every slot; otherwise `'pending'`.
 *
 * Edge cases: empty `requirements` → `'resumed'` (nothing required); a
 * `count: 0` requirement adds no slots (trivially satisfied); a principal voting
 * `resume` more than once under the same role is deduped (they still cover a
 * single slot — the DB unique `(run_gate_id, user_id)` constraint prevents this
 * upstream, deduped here defensively).
 */
export function evaluateGate(requirements: GateRequirement[], votes: ResumeVote[]): GateOutcome {
  if (votes.some(vote => vote.decision === ResumeDecisions.reject)) {
    return GateStates.rejected;
  }

  // Expand each requirement into individual role-slots to fill. A count <= 0 adds
  // none, so an all-zero (or empty) requirement set yields zero slots → resumed.
  const slots = requirements.flatMap(({ role, count }) => Array.from({ length: Math.max(0, count) }, () => role));

  // Which roles each principal can cover, from their `resume` votes. A Set dedupes
  // repeat votes by the same principal under the same role.
  const rolesByPrincipal = votes.reduce((map, { principalId, role }) => {
    const roles = map.get(principalId) ?? new Set<string>();
    roles.add(role);
    return map.set(principalId, roles);
  }, new Map<string, Set<string>>());
  const principals = [...rolesByPrincipal].map(([principalId, roles]) => ({ principalId, roles }));

  // Kuhn's augmenting-path maximum bipartite matching (small N — a handful of
  // slots/principals — so clarity beats an asymptotically faster max-flow). Each
  // principal is matched to at most one slot; a slot accepts a principal only if
  // that principal can cover the slot's role. `slotOfPrincipal` is the current
  // matching (principalId → slot index); `.some` short-circuits on the first
  // augmenting path found while recording it.
  const slotOfPrincipal = new Map<string, number>();

  const canFillSlot = (slotIndex: number, visited: Set<string>): boolean => {
    const role = slots[slotIndex];
    if (role === undefined) {
      return false;
    }
    return principals.some(({ principalId, roles }) => {
      if (visited.has(principalId) || !roles.has(role)) {
        return false;
      }
      visited.add(principalId);
      const held = slotOfPrincipal.get(principalId);
      // Free principal, or the principal's current slot can be re-homed elsewhere.
      if (held === undefined || canFillSlot(held, visited)) {
        slotOfPrincipal.set(principalId, slotIndex);
        return true;
      }
      return false;
    });
  };

  // A perfect matching (every slot filled by a distinct principal) means the gate
  // is satisfied. `.every` builds the matching incrementally and short-circuits
  // the moment a slot cannot be augmented into it — max-matching size is
  // order-independent, so one unfillable slot already proves it can't be perfect.
  return slots.every((_, slotIndex) => canFillSlot(slotIndex, new Set<string>()))
    ? GateStates.resumed
    : GateStates.pending;
}
