// The inbound domain's job handlers, as pure factories. runtime/jobs.ts registers
// them; this module never imports an instance.ts.
import { z } from 'zod';

import { defineJob, handleJob, type JobHandler } from '@backend/domain/jobs/handlers';

import type { InboundService } from '@backend/domain/inbound/InboundService';
import type { SystemSchedule } from '@backend/domain/jobs/repos/job-schedule.repo';

/** The inbound domain's job kinds. */
export const InboundJobKinds = {
  republishStale: 'inbound.republish-stale',
  prune: 'inbound.prune',
} as const;

/** Publishes receipts stuck in `pending` (a crash between recording and publishing). */
export const republishStaleReceipts = defineJob(InboundJobKinds.republishStale, z.object({}));

/** Deletes receipts older than 30 days. */
export const pruneReceipts = defineJob(InboundJobKinds.prune, z.object({}));

/** Every minute, as a platform schedule ensured by every tick. */
export const republishStaleSchedule: SystemSchedule = {
  kind: InboundJobKinds.republishStale,
  payload: {},
  intervalSeconds: 60,
};

/** Daily, like `events.prune`. */
export const pruneReceiptsSchedule: SystemSchedule = {
  kind: InboundJobKinds.prune,
  payload: {},
  intervalSeconds: 24 * 60 * 60,
};

/** The inbound schedules, for the runner's `systemSchedules`. */
export const inboundSchedules: readonly SystemSchedule[] = [republishStaleSchedule, pruneReceiptsSchedule];

/** The inbound domain's handlers, for the runtime registry (runtime/jobs.ts). Both
 * stop starting new work once the run's lock deadline has passed. */
export function createInboundHandlers(deps: { inbound: InboundService }): JobHandler[] {
  return [
    handleJob(republishStaleReceipts, async (_payload, ctx) => {
      await deps.inbound.republishStale({ deadline: ctx.deadline });
    }),
    handleJob(pruneReceipts, async (_payload, ctx) => {
      await deps.inbound.pruneReceipts({ deadline: ctx.deadline });
    }),
  ];
}
