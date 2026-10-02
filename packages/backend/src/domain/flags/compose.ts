// The flags domain's services, built over a db with their approval handlers registered.
// Pure (no instance imports), so the job runtime can build it without import cycles;
// instance.ts binds it to the production singletons.
import { FlagApprovalSubjects } from '@mocco/common/flags';

import { FlagGovernanceService } from '@backend/domain/flags/FlagGovernanceService';
import { FlagService } from '@backend/domain/flags/FlagService';
import { RulesetPublisher } from '@backend/domain/flags/RulesetPublisher';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type { EventPublisher } from '@backend/domain/events/ports';
import type { ApprovalService } from '@backend/domain/governance/ApprovalService';
import type { Db } from '@backend/infra/db/types';

export interface FlagsDomain {
  flags: FlagService;
  flagGovernance: FlagGovernanceService;
}

/** Build the flags services over a db and register their approval handlers on `approvals`.
 * The production root below binds it once; tests call it with a pglite db. */
export function createFlagsDomain(
  db: Db,
  deps: { audit: AuditService; approvals: ApprovalService; events?: EventPublisher; appOrigin?: string },
): FlagsDomain {
  const publisher = new RulesetPublisher();
  const flagGovernance = new FlagGovernanceService({ db, publisher, ...deps });
  const flags = new FlagService({ db, audit: deps.audit, publisher, governance: flagGovernance });
  deps.approvals.registerHandler(FlagApprovalSubjects.changeset, async request => {
    await flagGovernance.applyApproved(request);
  });
  deps.approvals.onRejected(FlagApprovalSubjects.changeset, async request => {
    await flagGovernance.markRejected(request);
  });
  deps.approvals.registerHandler(FlagApprovalSubjects.changeGate, async request => {
    await flagGovernance.applyApprovedGate(request);
  });
  return { flags, flagGovernance };
}
