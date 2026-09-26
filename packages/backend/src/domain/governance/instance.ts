// Production composition root for the governance domain. Lazy so builds don't need
// env at import. Like execution (and unlike integration, which is gated on the
// GitHub App env), governance has NO external dependency — it is always available,
// so `getGovernance()` never returns undefined and the tRPC context carries it
// non-optionally.
import { getAudit } from '@backend/domain/audit/instance';
import { getEventBus } from '@backend/domain/events/instance';
import { getExecution } from '@backend/domain/execution/instance';
import { RunEventRepo } from '@backend/domain/execution/repos/run-event.repo';
import { RunRepo } from '@backend/domain/execution/repos/run.repo';
import { ApprovalService } from '@backend/domain/governance/ApprovalService';
import { GateService } from '@backend/domain/governance/GateService';
import { ApprovalRequestRepo } from '@backend/domain/governance/repos/approval-request.repo';
import { ApprovalVoteRepo } from '@backend/domain/governance/repos/approval-vote.repo';
import { ResumeRepo } from '@backend/domain/governance/repos/resume.repo';
import { RoleMembershipRepo } from '@backend/domain/governance/repos/role-membership.repo';
import { RoleRepo } from '@backend/domain/governance/repos/role.repo';
import { RunGateRepo } from '@backend/domain/governance/repos/run-gate.repo';
import { RoleService } from '@backend/domain/governance/RoleService';
import { getDb } from '@backend/infra/db/client';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type { ApprovalHandler } from '@backend/domain/governance/ApprovalService';
import type { Db } from '@backend/infra/db/types';

export interface Governance {
  roles: RoleService;
  gates: GateService;
  approvals: ApprovalService;
}

/** Build the approval service over a db. The production root below binds it once;
 * tests call it with a pglite db — same classes, same wiring. */
export function createApprovalService(
  db: Db,
  audit: AuditService,
  handlers: ReadonlyMap<string, ApprovalHandler> = new Map(),
): ApprovalService {
  return new ApprovalService({
    requests: new ApprovalRequestRepo(db),
    votes: new ApprovalVoteRepo(db),
    memberships: new RoleMembershipRepo(db),
    audit,
    handlers,
  });
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
        bus: getEventBus(),
      }),
      // Subject handlers are bound here as product domains land (OTA version policy next).
      approvals: createApprovalService(db, getAudit().audit),
    };
  }
  return state.governance;
}
