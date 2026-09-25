// The one list of domain event subscribers (ADR 0018). Publish and delivery can run in
// different processes — a request lambda publishes and must know whom to enqueue for; a
// tick delivers and must find the handler — so both composition roots build their bus
// here: domain/events/instance.ts (publishers) and runtime/jobs.ts (`events.deliver`).
//
// Pure: subscribers come from factories (`domain/<x>/subscribers.ts`) that take repos and
// services as arguments. Never import an instance.ts here — that is what keeps the
// composition free of import cycles.
import { EventBus } from '@backend/domain/events/EventBus';
import { DomainEventRepo } from '@backend/domain/events/repos/domain-event.repo';
import { registerNotificationSubscribers } from '@backend/domain/notification/subscribers';

import type { DeliveredEvent } from '@backend/domain/events/EventBus';
import type { JobQueue } from '@backend/domain/jobs/ports';
import type { Db } from '@backend/infra/db/types';

export interface EventBusCompositionDeps {
  db: Db;
  queue: JobQueue;
  now: () => Date;
  /** The app's origin (`resolveBaseOrigin`), for links in notification messages. */
  appOrigin: string;
  /** Whether an event is a stage0 canary (`stage0CanaryMatcher`); absent when stage0 is off. */
  isCanary?: (event: DeliveredEvent) => boolean;
}

/** A bus with every subscriber registered. */
export function createEventBus(deps: EventBusCompositionDeps): EventBus {
  const bus = new EventBus({ events: new DomainEventRepo(deps.db), queue: deps.queue, now: deps.now });
  // Register each subscriber here under a stable name.
  registerNotificationSubscribers(bus, {
    db: deps.db,
    queue: deps.queue,
    appOrigin: deps.appOrigin,
    isCanary: deps.isCanary,
  });
  return bus;
}
