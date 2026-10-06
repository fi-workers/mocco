// The ops domain's job handlers and platform schedule, as pure factories.
// runtime/jobs.ts registers them; this module never imports an instance.ts.
import { z } from 'zod';

import { defineJob, handleJob, type JobHandler } from '@backend/domain/jobs/handlers';
import { STAGE0_CANARY_INTERVAL_SECONDS } from '@backend/domain/ops/Stage0CanaryService';

import type { SystemSchedule } from '@backend/domain/jobs/repos/job-schedule.repo';
import type { Stage0CanaryService } from '@backend/domain/ops/Stage0CanaryService';

/** The ops domain's job kinds. */
export const OpsJobKinds = {
  canary: 'stage0.canary',
} as const;

/** Send one stage0 canary through the public ingest route. */
export const stage0Canary = defineJob(OpsJobKinds.canary, z.object({}));

/** Every five minutes, ensured by every tick while stage0 is on. */
export const stage0CanarySchedule: SystemSchedule = {
  kind: OpsJobKinds.canary,
  payload: {},
  intervalSeconds: STAGE0_CANARY_INTERVAL_SECONDS,
};

/** The ops domain's handlers, for the runtime registry (runtime/jobs.ts). The handler is
 * registered even with stage0 off, so a schedule left from when it was on runs as a no-op. */
export function createOpsHandlers(deps: { canary: Stage0CanaryService | undefined }): JobHandler[] {
  return [
    handleJob(stage0Canary, async (_payload, ctx) => {
      await deps.canary?.send(`stage0-${ctx.jobId}`);
    }),
  ];
}
