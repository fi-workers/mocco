// The status domain's services over a db. Pure (no instance imports); instance.ts binds the
// production singletons, tests and the job runtime call it with their own db.
import { ComponentStatusService } from '@backend/domain/status/ComponentStatusService';
import { CorrelationService } from '@backend/domain/status/CorrelationService';
import { IncidentService } from '@backend/domain/status/IncidentService';
import { LocationService } from '@backend/domain/status/LocationService';
import { MaintenanceService } from '@backend/domain/status/MaintenanceService';
import { MonitorService } from '@backend/domain/status/MonitorService';
import { MonitorTransitionService } from '@backend/domain/status/MonitorTransitionService';
import { ProbeService } from '@backend/domain/status/ProbeService';
import { createReleaseDeploySource, createRunTimeline } from '@backend/domain/status/release-deploys';
import { SnapshotScheduler } from '@backend/domain/status/SnapshotScheduler';
import { SnapshotService } from '@backend/domain/status/SnapshotService';
import { StaticPublisher } from '@backend/domain/status/StaticPublisher';
import { StatusPageService } from '@backend/domain/status/StatusPageService';
import { VerdictEvaluator } from '@backend/domain/status/VerdictEvaluator';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type { EventPublisher } from '@backend/domain/events/ports';
import type { JobQueue } from '@backend/domain/jobs/ports';
import type { IncidentRow } from '@backend/domain/status/repos/incident.repo';
import type { ObjectStore } from '@backend/domain/storage/ports';
import type { Db } from '@backend/infra/db/types';

export interface StatusDomain {
  statusPages: StatusPageService;
  statusIncidents: IncidentService;
  statusMaintenances: MaintenanceService;
  statusMonitors: MonitorService;
  statusLocations: LocationService;
  statusProbes: ProbeService;
  statusVerdicts: VerdictEvaluator;
  statusCorrelation: CorrelationService;
}

export interface StatusDomainDeps {
  audit: Pick<AuditService, 'record'>;
  /** Where changes request a snapshot publish; without it pages are only marked dirty. */
  queue?: JobQueue;
  /** Where monitor alerts are published; without it there are none. */
  events?: EventPublisher;
  /** The app's origin, for the links in alerts. */
  appOrigin?: string;
  now?: () => Date;
}

export function createStatusDomain(db: Db, deps: StatusDomainDeps): StatusDomain {
  const now = deps.now === undefined ? {} : { now: deps.now };
  const snapshots = new SnapshotScheduler({ db, queue: deps.queue, now: deps.now ?? (() => new Date()) });
  // Deploy correlation reads releases and runs through its port, implemented here over their repos.
  const statusCorrelation = new CorrelationService({ db, deploys: createReleaseDeploySource(db), audit: deps.audit });
  const onOpened = async (incident: IncidentRow) => {
    await statusCorrelation.onIncidentOpened(incident);
  };
  const statusPages = new StatusPageService({
    db,
    audit: deps.audit,
    componentStatus: new ComponentStatusService({ db }),
    snapshots,
  });
  const transitions = new MonitorTransitionService({
    db,
    audit: deps.audit,
    snapshots,
    ...(deps.events !== undefined && { events: deps.events }),
    ...(deps.appOrigin !== undefined && { appOrigin: deps.appOrigin }),
    onIncidentOpened: onOpened,
    // A failure during a deploy watch goes on the run's timeline, through the execution repos.
    runTimeline: createRunTimeline(db),
    ...now,
  });
  const statusVerdicts = new VerdictEvaluator({
    db,
    onStateChange: async (monitor, change) => {
      await transitions.react(monitor, change);
    },
    ...now,
  });
  return {
    statusPages,
    statusVerdicts,
    statusCorrelation,
    statusIncidents: new IncidentService({ db, audit: deps.audit, pages: statusPages, snapshots, onOpened, ...now }),
    statusMaintenances: new MaintenanceService({ db, audit: deps.audit, pages: statusPages, snapshots, ...now }),
    statusMonitors: new MonitorService({ db, audit: deps.audit, ...now }),
    statusLocations: new LocationService({ db, audit: deps.audit, ...now }),
    statusProbes: new ProbeService({ db, verdicts: statusVerdicts, ...now }),
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
