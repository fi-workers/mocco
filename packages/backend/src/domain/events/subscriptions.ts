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

import type { JobQueue } from '@backend/domain/jobs/ports';
import type { Db } from '@backend/infra/db/types';

export interface EventBusCompositionDeps {
  db: Db;
  queue: JobQueue;
  now: () => Date;
}

/** A bus with every subscriber registered. */
export function createEventBus(deps: EventBusCompositionDeps): EventBus {
  const bus = new EventBus({ events: new DomainEventRepo(deps.db), queue: deps.queue, now: deps.now });
  // Register each subscriber here under a stable name, e.g. (the notification slice, #117):
  //   bus.subscribe('gate.*', 'notification.fan-out', async event => await notifications.handle(event));
  return bus;
}
