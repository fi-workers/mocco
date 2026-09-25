// The notification domain's event bus subscribers, as a pure factory
// (docs/reference/events.md#subscribing). `createEventBus` calls it; it builds its
// service from repos over the given db and never imports an instance.ts.
import { NotificationSubscribers } from '@backend/domain/notification/constants';
import { NotificationService } from '@backend/domain/notification/NotificationService';
import { ChannelRepo } from '@backend/domain/notification/repos/channel.repo';
import { DeliveryRepo } from '@backend/domain/notification/repos/delivery.repo';
import { RuleRepo } from '@backend/domain/notification/repos/rule.repo';

import type { DeliveredEvent, EventBus } from '@backend/domain/events/EventBus';
import type { JobQueue } from '@backend/domain/jobs/ports';
import type { Db } from '@backend/infra/db/types';

export interface NotificationSubscriberDeps {
  db: Db;
  queue: JobQueue;
  /** The app's origin, for links in governance messages. */
  appOrigin: string;
  /** Marks stage0 canary deliveries; absent when stage0 is off. */
  isCanary?: (event: DeliveredEvent) => boolean;
}

/** The fan-out service over `db`, as the subscribers use it. */
export function createNotificationService(deps: NotificationSubscriberDeps): NotificationService {
  return new NotificationService({
    channels: new ChannelRepo(deps.db),
    rules: new RuleRepo(deps.db),
    deliveries: new DeliveryRepo(deps.db),
    queue: deps.queue,
    appOrigin: deps.appOrigin,
    isCanary: deps.isCanary,
  });
}

/**
 * Subscribe the fan-out to every event family a rule can name: governance (`gate.*`,
 * `run.*`) and the inbound sources (`sentry.*`, `vercel.*`, `github.*`). A prefix with
 * no catalog types yet simply receives nothing until its types join the catalog.
 */
export function registerNotificationSubscribers(bus: EventBus, deps: NotificationSubscriberDeps): void {
  const notifications = createNotificationService(deps);
  const { gate, run, sentry, vercel, github } = NotificationSubscribers;
  bus.subscribe(gate.pattern, gate.name, async event => {
    await notifications.handle(event);
  });
  bus.subscribe(run.pattern, run.name, async event => {
    await notifications.handle(event);
  });
  bus.subscribe(sentry.pattern, sentry.name, async event => {
    await notifications.handle(event);
  });
  bus.subscribe(vercel.pattern, vercel.name, async event => {
    await notifications.handle(event);
  });
  bus.subscribe(github.pattern, github.name, async event => {
    await notifications.handle(event);
  });
}
