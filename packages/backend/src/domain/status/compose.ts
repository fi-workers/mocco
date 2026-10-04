// The status domain's services over a db. Pure (no instance imports); instance.ts binds the
// production singletons, tests and the job runtime call it with their own db.
import { ComponentStatusService } from '@backend/domain/status/ComponentStatusService';
import { IncidentService } from '@backend/domain/status/IncidentService';
import { MaintenanceService } from '@backend/domain/status/MaintenanceService';
import { StatusPageService } from '@backend/domain/status/StatusPageService';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type { Db } from '@backend/infra/db/types';

export interface StatusDomain {
  statusPages: StatusPageService;
  statusIncidents: IncidentService;
  statusMaintenances: MaintenanceService;
}

export function createStatusDomain(
  db: Db,
  deps: { audit: Pick<AuditService, 'record'>; now?: () => Date },
): StatusDomain {
  const now = deps.now === undefined ? {} : { now: deps.now };
  const statusPages = new StatusPageService({
    db,
    audit: deps.audit,
    componentStatus: new ComponentStatusService({ db }),
  });
  return {
    statusPages,
    statusIncidents: new IncidentService({ db, audit: deps.audit, pages: statusPages, ...now }),
    statusMaintenances: new MaintenanceService({ db, audit: deps.audit, pages: statusPages, ...now }),
  };
}
