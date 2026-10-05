// The notification domain's event bus subscribers, as a pure factory
// (docs/reference/events.md#subscribing). `createEventBus` calls it; it builds its
// service from repos over the given db and never imports an instance.ts.
import { NotificationSubscribers } from '@backend/domain/notification/constants';
import { NotificationService } from '@backend/domain/notification/NotificationService';
import { ChannelRepo } from '@backend/domain/notification/repos/channel.repo';
import { DeliveryRepo } from '@backend/domain/notification/repos/delivery.repo';
import { RuleRepo } from '@backend/domain/notification/repos/rule.repo';

import type { EventBus } from '@backend/domain/events/EventBus';
import type { JobQueue } from '@backend/domain/jobs/ports';
import type { Db } from '@backend/infra/db/types';

export interface NotificationSubscriberDeps {
  db: Db;
  queue: JobQueue;
  /** The app's origin, for links in governance messages. */
  appOrigin: string;
}

/** The fan-out service over `db`, as the subscribers use it. */
export function createNotificationService(deps: NotificationSubscriberDeps): NotificationService {
  return new NotificationService({
    channels: new ChannelRepo(deps.db),
    rules: new RuleRepo(deps.db),
    deliveries: new DeliveryRepo(deps.db),
    queue: deps.queue,
    appOrigin: deps.appOrigin,
  });
}

/**
 * Subscribe the fan-out to every event family a rule can name — one subscriber per
 * catalog family (`NotificationSubscribers`, whose type requires an entry for each).
 */
export function registerNotificationSubscribers(bus: EventBus, deps: NotificationSubscriberDeps): void {
  const notifications = createNotificationService(deps);
  // eslint-disable-next-line no-restricted-syntax -- registration is a side effect per entry, not a mapping
  for (const { pattern, name } of Object.values(NotificationSubscribers)) {
    bus.subscribe(pattern, name, async event => {
      await notifications.handle(event);
    });
  }
}
