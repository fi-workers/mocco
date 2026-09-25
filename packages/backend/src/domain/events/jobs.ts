// The events domain's job handlers, as pure factories. The composition root that
// builds the job runner registers them; this module never imports an instance.ts.
import { z } from 'zod';

import { deliverEvent, EventJobKinds, type EventBus } from '@backend/domain/events/EventBus';
import { defineJob, handleJob, type JobHandler } from '@backend/domain/jobs/handlers';

import type { DomainEventRepo } from '@backend/domain/events/repos/domain-event.repo';
import type { SystemSchedule } from '@backend/domain/jobs/repos/job-schedule.repo';

/** Domain events are kept this long (by `occurred_at`), then `events.prune` deletes them. */
export const EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Deletes events older than `EVENT_RETENTION_MS` (their delivery ledger cascades). */
export const pruneEvents = defineJob(EventJobKinds.prune, z.object({}));

/** Daily, as a platform schedule ensured by every tick (like `jobs.prune`). */
export const pruneEventsSchedule: SystemSchedule = {
  kind: EventJobKinds.prune,
  payload: {},
  intervalSeconds: 24 * 60 * 60,
};

/** `events.deliver` → `EventBus.deliver`. A subscriber error propagates, so the job retries. */
export function createDeliverEventHandler(bus: EventBus) {
  return handleJob(deliverEvent, async payload => {
    await bus.deliver(payload.eventId, payload.subscriber);
  });
}

export function createPruneEventsHandler(events: DomainEventRepo) {
  return handleJob(pruneEvents, async (_payload, ctx) => {
    await events.pruneBefore(new Date(ctx.now().getTime() - EVENT_RETENTION_MS));
  });
}

/** The events domain's handlers, for the runtime registry (runtime/jobs.ts). */
export function createEventHandlers(deps: { bus: EventBus; events: DomainEventRepo }): JobHandler[] {
  return [createDeliverEventHandler(deps.bus), createPruneEventsHandler(deps.events)];
}
