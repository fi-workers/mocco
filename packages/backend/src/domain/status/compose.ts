// The status domain's services over a db. Pure (no instance imports); instance.ts binds the
// production singletons, tests call it with a pglite db.
import { StatusPageService } from '@backend/domain/status/StatusPageService';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type { Db } from '@backend/infra/db/types';

export interface StatusDomain {
  statusPages: StatusPageService;
}

export function createStatusDomain(db: Db, deps: { audit: Pick<AuditService, 'record'> }): StatusDomain {
  return { statusPages: new StatusPageService({ db, audit: deps.audit }) };
}
