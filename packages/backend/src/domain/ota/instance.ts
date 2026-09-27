// Production composition root for the OTA domain. Lazy so builds don't need env at
// import. Binding the version-policy approval handler here keeps the dependency one-way
// (ota → governance): governance never imports a product domain.
import { OtaApprovalSubjects } from '@mocco/common/ota';

import { getAudit } from '@backend/domain/audit/instance';
import { getGovernance } from '@backend/domain/governance/instance';
import { AppVersionPolicyChangeRepo } from '@backend/domain/ota/repos/app-version-policy-change.repo';
import { AppVersionPolicyRepo } from '@backend/domain/ota/repos/app-version-policy.repo';
import { VersionCheckService } from '@backend/domain/ota/VersionCheckService';
import { VersionPolicyService } from '@backend/domain/ota/VersionPolicyService';
import { getProjectDomain } from '@backend/domain/project/instance';
import { getDb } from '@backend/infra/db/client';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type { ApprovalService } from '@backend/domain/governance/ApprovalService';
import type { ProjectService } from '@backend/domain/project/ProjectService';
import type { Db } from '@backend/infra/db/types';

export interface OtaDomain {
  versionPolicies: VersionPolicyService;
  versionChecks: VersionCheckService;
}

/** Build the OTA services over a db and register their approval handlers on `approvals`.
 * The production root below binds it once; tests call it with a pglite db. */
export function createOtaDomain(
  db: Db,
  deps: { projects: ProjectService; approvals: ApprovalService; audit: AuditService },
): OtaDomain {
  const policies = new AppVersionPolicyRepo(db);
  const versionPolicies = new VersionPolicyService({
    policies,
    changes: new AppVersionPolicyChangeRepo(db),
    ...deps,
  });
  deps.approvals.registerHandler(OtaApprovalSubjects.versionPolicy, async request => {
    await versionPolicies.applyApproved(request);
  });
  return { versionPolicies, versionChecks: new VersionCheckService({ policies }) };
}

const state: { ota?: OtaDomain } = {};

/** The OTA services. Always available (no external dependency to gate on). The tRPC
 * context builds this on every request, so the approval handler is registered before
 * any vote can reach it. */
export function getOtaDomain(): OtaDomain {
  state.ota ??= createOtaDomain(getDb(), {
    projects: getProjectDomain().projects,
    approvals: getGovernance().approvals,
    audit: getAudit().audit,
  });
  return state.ota;
}
