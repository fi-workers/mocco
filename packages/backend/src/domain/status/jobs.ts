// The status domain's job handlers, as pure factories. runtime/jobs.ts registers them;
// this module never imports an instance.ts.
import { SubscriberMailKinds } from '@mocco/common/status';
import { z } from 'zod';

import { defineJob, handleJob, type JobHandler } from '@backend/domain/jobs/handlers';
import { maintenanceStatusSchema } from '@backend/domain/status/subscriber-mail';

import type { SystemSchedule } from '@backend/domain/jobs/repos/job-schedule.repo';
import type { MaintenanceService } from '@backend/domain/status/MaintenanceService';
import type { RollupService } from '@backend/domain/status/RollupService';
import type { SnapshotService } from '@backend/domain/status/SnapshotService';
import type { SubscriberService } from '@backend/domain/status/SubscriberService';
import type { TimeSeriesRetention } from '@backend/domain/status/TimeSeriesRetention';
import type { VerdictEvaluator } from '@backend/domain/status/VerdictEvaluator';

export const StatusJobKinds = {
  maintenanceTick: 'status.maintenance.tick',
  snapshotPublish: 'status.snapshot.publish',
  retention: 'status.retention',
  evaluate: 'status.evaluate',
  rollup: 'status.rollup',
  subscribersFanOut: 'status.subscribers.fanout',
  subscribersDeliver: 'status.subscribers.deliver',
  subscribersPrune: 'status.subscribers.prune',
} as const;

/** Start and complete scheduled maintenance windows. */
export const tickMaintenance = defineJob(StatusJobKinds.maintenanceTick, z.object({}));

/** Publish one page's public snapshot; without a page, the safety run requests every page with work left. */
export const publishSnapshot = defineJob(StatusJobKinds.snapshotPublish, z.object({ pageId: z.uuid().optional() }));

/** Create the coming days' raw result and verdict partitions, drop the ones past retention, and
 * delete hourly rollups past theirs. */
export const runRetention = defineJob(StatusJobKinds.retention, z.object({}));

/** Close the monitor rounds that are due, decide them, and move the monitors' states. */
export const evaluateRounds = defineJob(StatusJobKinds.evaluate, z.object({}));

/** Roll the round verdicts and state changes up into hours, days and component days. */
export const runRollup = defineJob(StatusJobKinds.rollup, z.object({}));

/** Something subscribers hear about: an incident update (published incidents only) or a
 * maintenance window that was scheduled, started, completed or canceled. */
export const subscriberNoticeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal(SubscriberMailKinds.incidentUpdate),
    workspaceId: z.uuid(),
    projectId: z.uuid(),
    updateId: z.uuid(),
  }),
  z.object({
    kind: z.literal(SubscriberMailKinds.maintenance),
    workspaceId: z.uuid(),
    projectId: z.uuid(),
    maintenanceId: z.uuid(),
    status: maintenanceStatusSchema,
  }),
]);
export type SubscriberNotice = z.infer<typeof subscriberNoticeSchema>;

/** Queue one mail per subscriber who wants the notice (a delivery each, deduplicated). */
export const fanOutToSubscribers = defineJob(StatusJobKinds.subscribersFanOut, subscriberNoticeSchema);

/** Send one subscriber mail. */
export const deliverToSubscriber = defineJob(StatusJobKinds.subscribersDeliver, z.object({ deliveryId: z.uuid() }));

/** Delete sign-ups never confirmed and old settled deliveries. */
export const pruneSubscribers = defineJob(StatusJobKinds.subscribersPrune, z.object({}));

export const statusSchedules: SystemSchedule[] = [
  { kind: StatusJobKinds.evaluate, payload: {}, intervalSeconds: 60 },
  { kind: StatusJobKinds.maintenanceTick, payload: {}, intervalSeconds: 60 },
  // Hourly, so a missed run never leaves the next day without a partition.
  { kind: StatusJobKinds.retention, payload: {}, intervalSeconds: 3600 },
  // Every ten minutes: each run rolls up the hours that ended since the last one, so a day is
  // final within ten minutes of 00:10 UTC (RollupService.run).
  { kind: StatusJobKinds.rollup, payload: {}, intervalSeconds: 600 },
  { kind: StatusJobKinds.subscribersPrune, payload: {}, intervalSeconds: 24 * 60 * 60 },
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
  retention: Pick<TimeSeriesRetention, 'run'>;
  verdicts: Pick<VerdictEvaluator, 'evaluate'>;
  rollups: Pick<RollupService, 'run'>;
  /** Undefined without a signing key (AUTH_SECRET): notices are then dropped. */
  subscribers: Pick<SubscriberService, 'fanOut' | 'deliver' | 'prune'> | undefined;
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
    handleJob(runRetention, async () => {
      await deps.retention.run(deps.now());
    }),
    handleJob(evaluateRounds, async () => {
      await deps.verdicts.evaluate({ now: deps.now() });
    }),
    handleJob(runRollup, async () => {
      await deps.rollups.run(deps.now());
    }),
    handleJob(fanOutToSubscribers, async notice => {
      await deps.subscribers?.fanOut(notice);
    }),
    handleJob(deliverToSubscriber, async (payload, ctx) => {
      await deps.subscribers?.deliver(payload.deliveryId, { isFinalAttempt: ctx.isFinalAttempt, now: ctx.now() });
    }),
    handleJob(pruneSubscribers, async () => {
      await deps.subscribers?.prune(deps.now());
    }),
  ];
}
