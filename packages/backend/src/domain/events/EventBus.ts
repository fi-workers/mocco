import {
  domainEventPayloadSchemas,
  isDomainEventType,
  isEventPatternMatch,
  type DomainEventPattern,
  type DomainEventPayload,
  type DomainEventType,
  type MatchedEventType,
} from '@mocco/common/events';
import { z } from 'zod';

import {
  DomainEventPayloadError,
  InvalidSubscriptionError,
  UnknownDomainEventTypeError,
  UnknownSubscriberError,
} from '@backend/domain/events/errors';
import { defineJob } from '@backend/domain/jobs/handlers';

import type { DomainEventRepo, DomainEventRow } from '@backend/domain/events/repos/domain-event.repo';
import type { JobQueue } from '@backend/domain/jobs/ports';

/** The events domain's job kinds. */
export const EventJobKinds = {
  deliver: 'events.deliver',
  prune: 'events.prune',
} as const;

/** Hand one event to one subscriber. Deduped per (event, subscriber) while live; the
 * delivery ledger covers a second job after the first finished. */
export const deliverEvent = defineJob(
  EventJobKinds.deliver,
  z.object({ eventId: z.uuid(), subscriber: z.string().min(1) }),
);

/** What a publisher hands the bus. Distributive over the catalog, so `payload` is typed
 * by `type` at the call site. */
export type PublishInput = {
  [T in DomainEventType]: {
    type: T;
    workspaceId: string;
    /** The project the event belongs to, when it has one. */
    projectId?: string;
    /** What the event is about (`run` + run id, `run_gate` + gate id, …). */
    subject: { type: string; id: string };
    payload: z.input<(typeof domainEventPayloadSchemas)[T]>;
    /** When it happened; defaults to now. Retention counts from here. */
    occurredAt?: Date;
    /** Publish idempotently: a second publish with the same key in the workspace returns
     * the first event and enqueues nothing. */
    dedupeKey?: string;
  };
}[DomainEventType];

export interface PublishResult {
  event: DomainEventRow;
  /** false when an event with the same dedupe key already existed (that event is returned). */
  created: boolean;
  /** Subscribers a delivery job was enqueued for (empty when `created` is false). */
  subscribers: string[];
}

/** The event a subscriber receives: the stored row, with `type` and `payload` parsed by
 * the catalog. Distributive, so a handler for `gate.*` can narrow on `event.type`. */
export type DeliveredEvent<T extends DomainEventType = DomainEventType> = T extends DomainEventType
  ? Omit<DomainEventRow, 'type' | 'payload'> & { type: T; payload: DomainEventPayload<T> }
  : never;

interface Subscription {
  pattern: string;
  name: string;
  // Method syntax on purpose: it keeps a handler for a narrower event type assignable here.
  handle(event: DeliveredEvent): Promise<void>;
}

export interface EventBusDeps {
  events: DomainEventRepo;
  queue: JobQueue;
  now: () => Date;
}

/** Parse a stored row back through the catalog: its type must still be known and its
 * payload must still match (both were checked at publish). */
function toDeliveredEvent(row: DomainEventRow): DeliveredEvent {
  if (!isDomainEventType(row.type)) {
    throw new UnknownDomainEventTypeError(row.type);
  }
  const parsed = domainEventPayloadSchemas[row.type].safeParse(row.payload);
  if (!parsed.success) {
    throw new DomainEventPayloadError(row.type, { cause: parsed.error });
  }
  // The parse above is what makes this narrowing true.
  return { ...row, type: row.type, payload: parsed.data } as DeliveredEvent;
}

/**
 * The domain event bus (platform foundations §15, ADR 0018). `publish` validates the
 * payload against the catalog, stores the event, and enqueues one `events.deliver` job
 * per matching subscriber (`dedupe_key = <eventId>:<subscriber>`, kicked). `deliver`
 * is what that job runs: at-least-once, and a subscriber that already handled the event
 * is not called again. Subscribers are registered once, at composition, under stable
 * names (the name is part of the dedupe key and of the delivery ledger).
 */
export class EventBus {
  private readonly subscriptions: Subscription[] = [];

  constructor(private readonly deps: EventBusDeps) {}

  /**
   * Register `handler` under `name` for an exact catalog type or a `prefix.*` wildcard.
   * Call it from a composition root only. Throws on a duplicate name or an exact
   * pattern outside the catalog.
   */
  subscribe<P extends DomainEventPattern>(
    pattern: P,
    name: string,
    handler: (event: DeliveredEvent<MatchedEventType<P>>) => Promise<void>,
  ): void {
    if (/^\s*$/u.test(name)) {
      throw new InvalidSubscriptionError('a subscriber needs a name');
    }
    if (this.subscriptions.some(subscription => subscription.name === name)) {
      throw new InvalidSubscriptionError(`two subscribers are named "${name}"`);
    }
    if (!pattern.endsWith('.*') && !isDomainEventType(pattern)) {
      throw new InvalidSubscriptionError(`subscriber "${name}" listens to unknown event type "${pattern}"`);
    }
    this.subscriptions.push({ pattern, name, handle: handler });
  }

  /** Names of the subscribers registered for `type`, in registration order. */
  subscribersFor(type: string): string[] {
    return this.subscriptions
      .filter(subscription => isEventPatternMatch(subscription.pattern, type))
      .map(subscription => subscription.name);
  }

  /**
   * Validate, store, and fan out. Throws `UnknownDomainEventTypeError` /
   * `DomainEventPayloadError` before anything is written. A duplicate `dedupeKey`
   * returns the existing event and enqueues nothing.
   */
  async publish(input: PublishInput): Promise<PublishResult> {
    if (!isDomainEventType(input.type)) {
      throw new UnknownDomainEventTypeError(input.type);
    }
    const parsed = domainEventPayloadSchemas[input.type].safeParse(input.payload);
    if (!parsed.success) {
      throw new DomainEventPayloadError(input.type, { cause: parsed.error });
    }
    const { event, created } = await this.deps.events.insert({
      workspaceId: input.workspaceId,
      projectId: input.projectId ?? null,
      type: input.type,
      subjectType: input.subject.type,
      subjectId: input.subject.id,
      payload: parsed.data,
      dedupeKey: input.dedupeKey ?? null,
      occurredAt: input.occurredAt ?? this.deps.now(),
    });
    if (!created) {
      return { event, created, subscribers: [] };
    }
    const subscribers = this.subscribersFor(event.type);
    // One enqueue at a time: production's pool is a single connection.
    await subscribers.reduce(async (previous, subscriber) => {
      await previous;
      await this.deps.queue.enqueue(
        deliverEvent,
        { eventId: event.id, subscriber },
        { workspaceId: event.workspaceId, dedupeKey: `${event.id}:${subscriber}`, kick: true },
      );
    }, Promise.resolve());
    return { event, created, subscribers };
  }

  /**
   * Hand the event to the subscriber, once. A pruned event is a no-op; an event the
   * subscriber already handled is a no-op; a subscriber that throws propagates, so the
   * job retries. The ledger is written after the subscriber returns, so a crash in
   * between calls it again (at-least-once — subscribers must be idempotent).
   */
  async deliver(eventId: string, subscriberName: string): Promise<void> {
    const subscription = this.subscriptions.find(candidate => candidate.name === subscriberName);
    if (subscription === undefined) {
      throw new UnknownSubscriberError(subscriberName);
    }
    const row = await this.deps.events.findById(eventId);
    if (row === undefined) {
      console.warn(`[events] event ${eventId} is gone (pruned?); nothing to deliver to ${subscriberName}`);
      return;
    }
    if (await this.deps.events.isDelivered(eventId, subscriberName)) {
      return;
    }
    await subscription.handle(toDeliveredEvent(row));
    await this.deps.events.markDelivered(eventId, subscriberName, this.deps.now());
  }
}
