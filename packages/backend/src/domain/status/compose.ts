// The status domain's services over a db. Pure (no instance imports); instance.ts binds the
// production singletons, tests and the job runtime call it with their own db.
import { ComponentStatusService } from '@backend/domain/status/ComponentStatusService';
import { IncidentService } from '@backend/domain/status/IncidentService';
import { LocationService } from '@backend/domain/status/LocationService';
import { MaintenanceService } from '@backend/domain/status/MaintenanceService';
import { MonitorService } from '@backend/domain/status/MonitorService';
import { SnapshotScheduler } from '@backend/domain/status/SnapshotScheduler';
import { SnapshotService } from '@backend/domain/status/SnapshotService';
import { StaticPublisher } from '@backend/domain/status/StaticPublisher';
import { StatusPageService } from '@backend/domain/status/StatusPageService';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type { JobQueue } from '@backend/domain/jobs/ports';
import type { ObjectStore } from '@backend/domain/storage/ports';
import type { Db } from '@backend/infra/db/types';

export interface StatusDomain {
  statusPages: StatusPageService;
  statusIncidents: IncidentService;
  statusMaintenances: MaintenanceService;
  statusMonitors: MonitorService;
  statusLocations: LocationService;
}

export interface StatusDomainDeps {
  audit: Pick<AuditService, 'record'>;
  /** Where changes request a snapshot publish; without it pages are only marked dirty. */
  queue?: JobQueue;
  now?: () => Date;
}

export function createStatusDomain(db: Db, deps: StatusDomainDeps): StatusDomain {
  const now = deps.now === undefined ? {} : { now: deps.now };
  const snapshots = new SnapshotScheduler({ db, queue: deps.queue, now: deps.now ?? (() => new Date()) });
  const statusPages = new StatusPageService({
    db,
    audit: deps.audit,
    componentStatus: new ComponentStatusService({ db }),
    snapshots,
  });
  return {
    statusPages,
    statusIncidents: new IncidentService({ db, audit: deps.audit, pages: statusPages, snapshots, ...now }),
    statusMaintenances: new MaintenanceService({ db, audit: deps.audit, pages: statusPages, snapshots, ...now }),
    statusMonitors: new MonitorService({ db, audit: deps.audit, ...now }),
    statusLocations: new LocationService({ db, audit: deps.audit, ...now }),
  };
}

/** The snapshot publisher over the object store, or undefined when there is none.
 *
 * sonarjs/function-return-type is a false positive: every branch returns the declared type. */
// eslint-disable-next-line sonarjs/function-return-type
export function createSnapshotService(
  db: Db,
  deps: { store: ObjectStore | undefined; queue: JobQueue; now?: () => Date },
): SnapshotService | undefined {
  if (deps.store === undefined) {
    return undefined;
  }
  return new SnapshotService({
    db,
    publisher: new StaticPublisher(deps.store),
    scheduler: new SnapshotScheduler({ db, queue: deps.queue, now: deps.now ?? (() => new Date()) }),
    componentStatus: new ComponentStatusService({ db }),
    ...(deps.now !== undefined && { now: deps.now }),
  });
}
