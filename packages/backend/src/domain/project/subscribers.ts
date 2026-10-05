// The release registry's event bus subscriber, as a pure factory
// (docs/reference/events.md#subscribing). `createEventBus` calls it; it never imports an
// instance.ts.
import { DomainEventTypes } from '@mocco/common/events';

import { createReleaseService } from '@backend/domain/project/compose';

import type { EventBus } from '@backend/domain/events/EventBus';
import type { Db } from '@backend/infra/db/types';

/** The registry's subscriber name. Permanent: it is in delivery dedupe keys and the ledger. */
export const RELEASE_SUBSCRIBER = 'release.record';

/** On `run.succeeded`, record the run's releases and publish `deploy.released` when it passed
 * a resumed gate. A failure throws, so the delivery job retries (both writes are idempotent). */
export function registerReleaseSubscribers(bus: EventBus, deps: { db: Db }): void {
  const releases = createReleaseService(deps.db, { bus });
  bus.subscribe(DomainEventTypes.runSucceeded, RELEASE_SUBSCRIBER, async event => {
    await releases.recordRun(event.workspaceId, event.payload.runId);
  });
}
