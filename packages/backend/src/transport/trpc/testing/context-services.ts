// Test-only: the context services every tRPC router test needs besides the ones it
// builds itself (projects, product enablement, approvals, OTA), wired exactly as the
// production composition roots wire them — one approval service per context with the
// OTA handlers registered on it. Not imported by production code.
import { randomBytes } from 'node:crypto';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { createApprovalService } from '@backend/domain/governance/instance';
import { createOtaDomain } from '@backend/domain/ota/instance';
import { createProjectDomain } from '@backend/domain/project/instance';
import { SecretBox } from '@backend/infra/crypto/secret-box';

import type { Db } from '@backend/infra/db/types';

export function contextServices(db: Db) {
  const audit = new AuditService({ audit: new AuditRepo(db) });
  const project = createProjectDomain(db);
  const approvals = createApprovalService(db, audit);
  // A random SecretBox key per context — no env, no seam.
  const box = new SecretBox([{ id: 'test', key: randomBytes(32) }]);
  const ota = createOtaDomain(db, { projects: project.projects, approvals, audit, secretBox: () => box });
  return {
    ...project,
    approvals,
    ...ota,
    // Optional services default to absent; a test that exercises one passes it after the spread.
    connection: undefined,
    commitSync: undefined,
    commitConfig: undefined,
    inbound: undefined,
    notifications: undefined,
    notificationActivity: undefined,
  };
}
