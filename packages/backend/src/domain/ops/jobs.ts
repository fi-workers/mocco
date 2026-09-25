// The ops domain's job handler and platform schedule, as pure factories. runtime/jobs.ts
// registers them; this module never imports an instance.ts.
import { z } from 'zod';

import { defineJob, handleJob, type JobHandler } from '@backend/domain/jobs/handlers';
import { OpsJobKinds, Stage0Policy } from '@backend/domain/ops/constants';

import type { SystemSchedule } from '@backend/domain/jobs/repos/job-schedule.repo';
import type { Stage0Service } from '@backend/domain/ops/Stage0Service';

/** Sends one stage0 canary and prunes old canary records. */
export const sendStage0Canary = defineJob(OpsJobKinds.stage0Canary, z.object({}));

/** Every 5 minutes. */
export const stage0CanarySchedule: SystemSchedule = {
  kind: OpsJobKinds.stage0Canary,
  payload: {},
  intervalSeconds: Stage0Policy.canaryIntervalSeconds,
};

/** The ops schedules, for the runner's `systemSchedules`: the canary only while stage0
 * is configured. */
export function opsSchedules(isStage0Enabled: boolean): readonly SystemSchedule[] {
  return isStage0Enabled ? [stage0CanarySchedule] : [];
}

/**
 * The ops handlers, for the runtime registry. The handler is registered even when stage0
 * is off, so the schedule row left by a deploy that had it on runs as a no-op instead of
 * an unknown kind. An expected canary failure is recorded, not thrown: retrying would
 * only send more canaries, and the missing heartbeat is the alert.
 */
export function createOpsHandlers(deps: { stage0: Stage0Service }): JobHandler[] {
  return [
    handleJob(sendStage0Canary, async (_payload, ctx) => {
      await deps.stage0.sendCanary(ctx.now());
      await deps.stage0.pruneCanaries(ctx.now());
    }),
  ];
}
