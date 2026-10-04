// The status domain's job handlers, as pure factories. runtime/jobs.ts registers them;
// this module never imports an instance.ts.
import { z } from 'zod';

import { defineJob, handleJob, type JobHandler } from '@backend/domain/jobs/handlers';

import type { SystemSchedule } from '@backend/domain/jobs/repos/job-schedule.repo';
import type { MaintenanceService } from '@backend/domain/status/MaintenanceService';

export const StatusJobKinds = {
  maintenanceTick: 'status.maintenance.tick',
} as const;

/** Start and complete scheduled maintenance windows. */
export const tickMaintenance = defineJob(StatusJobKinds.maintenanceTick, z.object({}));

export const statusSchedules: SystemSchedule[] = [
  { kind: StatusJobKinds.maintenanceTick, payload: {}, intervalSeconds: 60 },
];

export function createStatusHandlers(deps: {
  maintenances: Pick<MaintenanceService, 'tick'>;
  now: () => Date;
}): JobHandler[] {
  return [
    handleJob(tickMaintenance, async () => {
      await deps.maintenances.tick(deps.now());
    }),
  ];
}
