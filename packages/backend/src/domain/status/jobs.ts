// The status domain's job handlers, as pure factories. runtime/jobs.ts registers them;
// this module never imports an instance.ts.
import { z } from 'zod';

import { defineJob, handleJob, type JobHandler } from '@backend/domain/jobs/handlers';

import type { SystemSchedule } from '@backend/domain/jobs/repos/job-schedule.repo';
import type { MaintenanceService } from '@backend/domain/status/MaintenanceService';
import type { SnapshotService } from '@backend/domain/status/SnapshotService';

export const StatusJobKinds = {
  maintenanceTick: 'status.maintenance.tick',
  snapshotPublish: 'status.snapshot.publish',
} as const;

/** Start and complete scheduled maintenance windows. */
export const tickMaintenance = defineJob(StatusJobKinds.maintenanceTick, z.object({}));

/** Publish one page's public snapshot; without a page, the safety run requests every page with work left. */
export const publishSnapshot = defineJob(StatusJobKinds.snapshotPublish, z.object({ pageId: z.uuid().optional() }));

export const statusSchedules: SystemSchedule[] = [
  { kind: StatusJobKinds.maintenanceTick, payload: {}, intervalSeconds: 60 },
];

/** The five-minute safety run, registered only when an object store is configured. */
export const snapshotSafetySchedule: SystemSchedule = {
  kind: StatusJobKinds.snapshotPublish,
  payload: {},
  intervalSeconds: 300,
};

export function createStatusHandlers(deps: {
  maintenances: Pick<MaintenanceService, 'tick'>;
  /** Undefined when no object store is configured. */
  snapshots: Pick<SnapshotService, 'publish' | 'sweep'> | undefined;
  now: () => Date;
}): JobHandler[] {
  return [
    handleJob(tickMaintenance, async () => {
      await deps.maintenances.tick(deps.now());
    }),
    handleJob(publishSnapshot, async payload => {
      if (deps.snapshots === undefined) {
        return;
      }
      await (payload.pageId === undefined ? deps.snapshots.sweep() : deps.snapshots.publish(payload.pageId));
    }),
  ];
}
