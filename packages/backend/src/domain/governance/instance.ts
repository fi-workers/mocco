// Production composition root for the governance domain. Lazy so builds don't need
// env at import. Like execution (and unlike integration, which is gated on the
// GitHub App env), governance has NO external dependency — it is always available,
// so `getGovernance()` never returns undefined and the tRPC context carries it
// non-optionally.
import { getAudit } from '@backend/domain/audit/instance';
import { getExecution } from '@backend/domain/execution/instance';
import { RunEventRepo } from '@backend/domain/execution/repos/run-event.repo';
import { RunRepo } from '@backend/domain/execution/repos/run.repo';
import { GateService } from '@backend/domain/governance/GateService';
import { ResumeRepo } from '@backend/domain/governance/repos/resume.repo';
import { RoleMembershipRepo } from '@backend/domain/governance/repos/role-membership.repo';
import { RoleRepo } from '@backend/domain/governance/repos/role.repo';
import { RunGateRepo } from '@backend/domain/governance/repos/run-gate.repo';
import { RoleService } from '@backend/domain/governance/RoleService';
import { getDb } from '@backend/infra/db/client';

export interface Governance {
  roles: RoleService;
  gates: GateService;
}

const state: { governance?: Governance } = {};

/** The governance services. Always available (no external dependency to gate on). */
export function getGovernance(): Governance {
  if (!state.governance) {
    const db = getDb();
    // GateService drives a satisfied gate's run forward through RunService — injected
    // as a narrow callback (resumeFromGate) to keep the composition acyclic.
    const execution = getExecution();
    state.governance = {
      roles: new RoleService({
        roles: new RoleRepo(db),
        memberships: new RoleMembershipRepo(db),
      }),
      gates: new GateService({
        runs: new RunRepo(db),
        runGates: new RunGateRepo(db),
        resumes: new ResumeRepo(db),
        memberships: new RoleMembershipRepo(db),
        events: new RunEventRepo(db),
        resumeRun: async (run, gateItemIndex) => await execution.runs.resumeFromGate(run, gateItemIndex),
        audit: getAudit().audit,
      }),
    };
  }
  return state.governance;
}
