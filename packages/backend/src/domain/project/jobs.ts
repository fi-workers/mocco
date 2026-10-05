// The release registry's job handlers, as pure factories. The composition root that builds
// the job runner registers them; this module never imports an instance.ts.
import { z } from 'zod';

import { defineJob, handleJob, type JobHandler } from '@backend/domain/jobs/handlers';

import type { SystemSchedule } from '@backend/domain/jobs/repos/job-schedule.repo';
import type { ReleaseService } from '@backend/domain/project/ReleaseService';

export const ReleaseJobKinds = {
  reconcile: 'releases.reconcile',
} as const;

/** Records the released runs the `run.succeeded` subscriber missed (ADR 0018: a crash between
 * a state change and its publish loses the event). */
export const reconcileReleases = defineJob(ReleaseJobKinds.reconcile, z.object({}));

/** Hourly, as a platform schedule ensured by every tick. */
export const reconcileReleasesSchedule: SystemSchedule = {
  kind: ReleaseJobKinds.reconcile,
  payload: {},
  intervalSeconds: 60 * 60,
};

export function createReleaseHandlers(deps: { releases: ReleaseService }): JobHandler[] {
  return [
    handleJob(reconcileReleases, async (_payload, ctx) => {
      await deps.releases.reconcile(ctx.now());
    }),
  ];
}
