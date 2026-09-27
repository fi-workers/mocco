import { BadRequestError } from '@backend/domain/errors';

/** A publish named a type that is not in the `@mocco/common/events` catalog. */
export class UnknownDomainEventTypeError extends BadRequestError {
  constructor(type: string, options?: ErrorOptions) {
    super(`Unknown domain event type "${type}"`, options);
    this.name = 'UnknownDomainEventTypeError';
  }
}

/** A publish (or a stored row being delivered) whose payload fails its catalog schema.
 * The zod error is the `cause`. */
export class DomainEventPayloadError extends BadRequestError {
  constructor(type: string, options?: ErrorOptions) {
    super(`Payload does not match the schema of domain event "${type}"`, options);
    this.name = 'DomainEventPayloadError';
  }
}

/** A composition-time mistake: a duplicate subscriber name, or an exact pattern that is
 * not a catalog type. Thrown at startup, never at delivery. */
export class InvalidSubscriptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSubscriptionError';
  }
}

/** A delivery job names a subscriber this process has not registered (e.g. an older
 * deploy handling a newer job). A normal failure, so the job is retried. */
export class UnknownSubscriberError extends Error {
  constructor(subscriber: string) {
    super(`No subscriber named "${subscriber}" is registered`);
    this.name = 'UnknownSubscriberError';
  }
}
