// The notification domain's job handlers, as a pure factory. runtime/jobs.ts registers
// them; this module never imports an instance.ts.
import { handleJob, type JobHandler } from '@backend/domain/jobs/handlers';
import { DeliveryService, type DeliveryServiceDeps } from '@backend/domain/notification/DeliveryService';
import { deliverNotification } from '@backend/domain/notification/NotificationService';

/** `notification.deliver` → `DeliveryService.deliver`. A thrown RetryAt or transient failure retries the job. */
export function createDeliverNotificationHandler(service: DeliveryService) {
  return handleJob(deliverNotification, async (payload, ctx) => {
    await service.deliver(payload.deliveryId, { attempt: ctx.attempt, now: ctx.now() });
  });
}

/** The notification domain's handlers, for the runtime registry (runtime/jobs.ts). */
export function createNotificationHandlers(deps: DeliveryServiceDeps): JobHandler[] {
  return [createDeliverNotificationHandler(new DeliveryService(deps))];
}
