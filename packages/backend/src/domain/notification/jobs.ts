// The notification domain's job handlers and platform schedules, as pure factories.
// runtime/jobs.ts registers them; this module never imports an instance.ts.
import { z } from 'zod';

import { defineJob, handleJob, type JobHandler } from '@backend/domain/jobs/handlers';
import { DeliveryPolicy, NotificationJobKinds } from '@backend/domain/notification/constants';
import { DeliveryService, type DeliveryServiceDeps } from '@backend/domain/notification/DeliveryService';
import { deliverNotification } from '@backend/domain/notification/NotificationService';

import type { SystemSchedule } from '@backend/domain/jobs/repos/job-schedule.repo';
import type { DiscordConnectStateRepo } from '@backend/domain/notification/repos/discord-connect-state.repo';

/** Fail deliveries whose `notification.deliver` job died before settling them. */
export const reconcileDeliveries = defineJob(NotificationJobKinds.reconcile, z.object({}));

/** Delete expired Discord rate limit buckets and expired or consumed install states. */
export const pruneNotifications = defineJob(NotificationJobKinds.prune, z.object({}));

/** The notification domain's platform schedules, ensured by every tick. */
export const notificationSchedules: SystemSchedule[] = [
  { kind: NotificationJobKinds.reconcile, payload: {}, intervalSeconds: DeliveryPolicy.reconcileIntervalSeconds },
  { kind: NotificationJobKinds.prune, payload: {}, intervalSeconds: 24 * 60 * 60 },
];

/** `notification.deliver` → `DeliveryService.deliver`. A thrown RetryAt or transient failure retries the job. */
export function createDeliverNotificationHandler(service: DeliveryService) {
  return handleJob(deliverNotification, async (payload, ctx) => {
    await service.deliver(payload.deliveryId, { isFinalAttempt: ctx.isFinalAttempt, now: ctx.now() });
  });
}

export interface NotificationHandlerDeps extends DeliveryServiceDeps {
  connectStates: DiscordConnectStateRepo;
}

/** The notification domain's handlers, for the runtime registry (runtime/jobs.ts). */
export function createNotificationHandlers({ connectStates, ...deps }: NotificationHandlerDeps): JobHandler[] {
  const service = new DeliveryService(deps);
  return [
    createDeliverNotificationHandler(service),
    handleJob(reconcileDeliveries, async () => {
      await service.reconcile();
    }),
    handleJob(pruneNotifications, async (_payload, ctx) => {
      await service.pruneRateLimits(ctx.now());
      await connectStates.prune(ctx.now());
    }),
  ];
}
