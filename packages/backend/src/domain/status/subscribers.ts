// The status domain's event bus subscribers, as a pure factory
// (docs/reference/events.md#subscribing). `createEventBus` calls it; it never imports an
// instance.ts.
import { DomainEventTypes } from '@mocco/common/events';
import { RunStates } from '@mocco/common/execution';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { createStatusDomain } from '@backend/domain/status/compose';
import { DeployWatchService } from '@backend/domain/status/DeployWatchService';

import type { EventBus } from '@backend/domain/events/EventBus';
import type { JobQueue } from '@backend/domain/jobs/ports';
import type { Db } from '@backend/infra/db/types';

/** The deploy watch's subscriber name. Permanent: it is in delivery dedupe keys and the ledger. */
export const DEPLOY_WATCH_SUBSCRIBER = 'status.deploy_watch';

/** Gate-linked maintenance's subscriber names (#158). Permanent, like the deploy watch's. */
export const MaintenanceSubscribers = {
  gateResumed: 'status.maintenance.gate_resumed',
  runSucceeded: 'status.maintenance.run_succeeded',
  runFailed: 'status.maintenance.run_failed',
  gateRejected: 'status.maintenance.gate_rejected',
} as const;

export interface StatusSubscriberDeps {
  db: Db;
  /** Where a window's change requests a snapshot publish. */
  queue?: JobQueue;
  appOrigin?: string;
  now?: () => Date;
}

/**
 * On `deploy.released`, watch the released projects' monitors (#155). The trigger is the
 * release, not `run.succeeded`: only a run that passed a resumed gate is a production deploy,
 * and the release names the projects its repo is linked to. Idempotent, so a redelivery is safe.
 *
 * On `gate.resumed`, start the maintenance windows the gate announces; on `run.succeeded`,
 * `run.failed` and `gate.rejected`, complete the run's windows (#158). Also idempotent.
 */
export function registerStatusSubscribers(bus: EventBus, deps: StatusSubscriberDeps): void {
  const now = deps.now === undefined ? {} : { now: deps.now };
  const watches = new DeployWatchService({ db: deps.db, ...now });
  bus.subscribe(DomainEventTypes.deployReleased, DEPLOY_WATCH_SUBSCRIBER, async event => {
    await watches.startWatch({
      workspaceId: event.workspaceId,
      projectIds: event.payload.projectIds,
      runId: event.payload.runId,
      releasedAt: new Date(event.payload.releasedAt),
    });
  });

  // The overrun alert is published on this same bus.
  const maintenances = createStatusDomain(deps.db, {
    audit: new AuditService({ audit: new AuditRepo(deps.db) }),
    events: bus,
    ...(deps.queue !== undefined && { queue: deps.queue }),
    ...(deps.appOrigin !== undefined && { appOrigin: deps.appOrigin }),
    ...now,
  }).statusMaintenances;
  bus.subscribe(DomainEventTypes.gateResumed, MaintenanceSubscribers.gateResumed, async event => {
    await maintenances.startForGate({
      workspaceId: event.workspaceId,
      runId: event.payload.runId,
      // The event's subject is the run gate.
      gateId: event.subjectId,
      gateName: event.payload.gateName,
    });
  });
  bus.subscribe(DomainEventTypes.runSucceeded, MaintenanceSubscribers.runSucceeded, async event => {
    await maintenances.completeForRun({
      workspaceId: event.workspaceId,
      runId: event.payload.runId,
      state: RunStates.succeeded,
    });
  });
  bus.subscribe(DomainEventTypes.runFailed, MaintenanceSubscribers.runFailed, async event => {
    await maintenances.completeForRun({
      workspaceId: event.workspaceId,
      runId: event.payload.runId,
      state: RunStates.failed,
    });
  });
  bus.subscribe(DomainEventTypes.gateRejected, MaintenanceSubscribers.gateRejected, async event => {
    await maintenances.completeForRun({
      workspaceId: event.workspaceId,
      runId: event.payload.runId,
      state: RunStates.rejected,
    });
  });
}
