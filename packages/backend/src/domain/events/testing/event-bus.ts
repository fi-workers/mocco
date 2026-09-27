// Test-only event bus wiring (test infra, like execution/testing/fake-executor.ts —
// never imported by production code). Service tests publish through the real
// EventBus over pglite and assert the stored rows; nothing is kicked.
import { EventBus } from '@backend/domain/events/EventBus';
import { DomainEventRepo } from '@backend/domain/events/repos/domain-event.repo';
import { PostgresJobQueue } from '@backend/domain/jobs/PostgresJobQueue';
import { JobRepo } from '@backend/domain/jobs/repos/job.repo';

import type { EventPublisher } from '@backend/domain/events/ports';
import type { Db } from '@backend/infra/db/types';

/** A real bus over `db`. Kicked deliveries are dropped (the rows stay queued). */
export function createTestEventBus(db: Db, now: () => Date = () => new Date()): EventBus {
  const queue = new PostgresJobQueue({
    jobs: new JobRepo(db),
    now,
    runOne: async () => await Promise.resolve(null),
    waitUntil: () => {},
  });
  return new EventBus({ events: new DomainEventRepo(db), queue, now });
}

/** A publisher whose every publish fails — proves a caller treats publishing as best-effort. */
export class FailingEventPublisher implements EventPublisher {
  attempts = 0;

  async publish(): Promise<never> {
    this.attempts += 1;
    return await Promise.reject(new Error('event bus is down'));
  }
}
