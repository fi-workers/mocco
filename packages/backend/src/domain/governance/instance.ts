// Production composition root for the governance domain. Lazy so builds don't need
// env at import. Like execution (and unlike integration, which is gated on the
// GitHub App env), governance has NO external dependency — it is always available,
// so `getGovernance()` never returns undefined and the tRPC context carries it
// non-optionally.
import { RoleMembershipRepo } from '@backend/domain/governance/repos/role-membership.repo';
import { RoleRepo } from '@backend/domain/governance/repos/role.repo';
import { RoleService } from '@backend/domain/governance/RoleService';
import { getDb } from '@backend/infra/db/client';

export interface Governance {
  roles: RoleService;
}

const state: { governance?: Governance } = {};

/** The governance services. Always available (no external dependency to gate on). */
export function getGovernance(): Governance {
  if (!state.governance) {
    const db = getDb();
    state.governance = {
      roles: new RoleService({
        roles: new RoleRepo(db),
        memberships: new RoleMembershipRepo(db),
      }),
    };
  }
  return state.governance;
}
