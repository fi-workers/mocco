// The flags domain's job handlers, as pure factories. runtime/jobs.ts registers them;
// this module never imports an instance.ts.
import { z } from 'zod';

import { defineJob, handleJob, type JobHandler } from '@backend/domain/jobs/handlers';

import type { FlagGovernanceService } from '@backend/domain/flags/FlagGovernanceService';
import type { SystemSchedule } from '@backend/domain/jobs/repos/job-schedule.repo';

export const FlagJobKinds = {
  expireChangesets: 'flags.changesets.expire',
} as const;

/** Expire changesets to protected environments that waited past their approval window. */
export const expireFlagChangesets = defineJob(FlagJobKinds.expireChangesets, z.object({}));

export const expireFlagChangesetsSchedule: SystemSchedule = {
  kind: FlagJobKinds.expireChangesets,
  payload: {},
  intervalSeconds: 15 * 60,
};

export function createFlagHandlers(deps: { governance: FlagGovernanceService }): JobHandler[] {
  return [
    handleJob(expireFlagChangesets, async () => {
      await deps.governance.expireDue();
    }),
  ];
}
