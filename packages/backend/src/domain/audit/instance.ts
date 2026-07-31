// Production composition root for the audit domain. Lazy so builds don't need env at
// import. Like governance/execution/credential (and unlike integration, which is gated
// on the GitHub App env), the audit domain has NO external dependency — the hash chain
// is self-contained (the deferred KMS signing is a later, port-side swap), so
// `getAudit()` never returns undefined and the tRPC/write-path contexts carry it
// non-optionally.
import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { getDb } from '@backend/infra/db/client';

export interface Audit {
  audit: AuditService;
}

const state: { audit?: Audit } = {};

/** The audit service. Always available (no external dependency to gate on). */
export function getAudit(): Audit {
  if (!state.audit) {
    const db = getDb();
    state.audit = { audit: new AuditService({ audit: new AuditRepo(db) }) };
  }
  return state.audit;
}
