// The status domain's event bus subscriber, as a pure factory
// (docs/reference/events.md#subscribing). `createEventBus` calls it; it never imports an
// instance.ts.
import { DomainEventTypes } from '@mocco/common/events';

import { DeployWatchService } from '@backend/domain/status/DeployWatchService';

import type { EventBus } from '@backend/domain/events/EventBus';
import type { Db } from '@backend/infra/db/types';

/** The deploy watch's subscriber name. Permanent: it is in delivery dedupe keys and the ledger. */
export const DEPLOY_WATCH_SUBSCRIBER = 'status.deploy_watch';

/**
 * On `deploy.released`, watch the released projects' monitors (#155). The trigger is the
 * release, not `run.succeeded`: only a run that passed a resumed gate is a production deploy,
 * and the release names the projects its repo is linked to. Idempotent, so a redelivery is safe.
 */
export function registerStatusSubscribers(bus: EventBus, deps: { db: Db; now?: () => Date }): void {
  const watches = new DeployWatchService({ db: deps.db, ...(deps.now !== undefined && { now: deps.now }) });
  bus.subscribe(DomainEventTypes.deployReleased, DEPLOY_WATCH_SUBSCRIBER, async event => {
    await watches.startWatch({
      workspaceId: event.workspaceId,
      projectIds: event.payload.projectIds,
      runId: event.payload.runId,
      releasedAt: new Date(event.payload.releasedAt),
    });
  });
}
