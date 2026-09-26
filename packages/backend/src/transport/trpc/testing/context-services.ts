// Test-only: the context services every tRPC router test needs besides the ones it
// builds itself (projects, product enablement, approvals, OTA), wired exactly as the
// production composition roots wire them — one approval service per context with the
// OTA handlers registered on it. Not imported by production code.
import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { createApprovalService } from '@backend/domain/governance/instance';
import { createOtaDomain } from '@backend/domain/ota/instance';
import { createProjectDomain } from '@backend/domain/project/instance';

import type { Db } from '@backend/infra/db/types';

export function contextServices(db: Db) {
  const audit = new AuditService({ audit: new AuditRepo(db) });
  const project = createProjectDomain(db);
  const approvals = createApprovalService(db, audit);
  const ota = createOtaDomain(db, { projects: project.projects, approvals, audit });
  return { ...project, approvals, ...ota };
}
