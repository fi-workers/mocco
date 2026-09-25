import type { EventBus, PublishInput } from '@backend/domain/events/EventBus';

/** The publishing half of the bus — what a domain service depends on. Tests pass the
 * real `EventBus` over pglite, or a stub that throws to prove publishing is best-effort. */
export type EventPublisher = Pick<EventBus, 'publish'>;

/**
 * Publish an event without letting a failure reach the caller. For governance facts
 * published after the state change they describe (`run.succeeded`, `gate.pending`, …):
 * the change is already committed and must not roll back or fail because a
 * notification could not be queued. Building the input (e.g. loading the run's repo) is
 * inside the guard too. Failures are logged with `label`.
 */
export async function publishBestEffort(
  publisher: EventPublisher,
  label: string,
  build: () => Promise<PublishInput>,
): Promise<void> {
  try {
    await publisher.publish(await build());
  } catch (error) {
    console.error(`[events] publishing ${label} failed; the state change stands`, error);
  }
}
