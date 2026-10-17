// The feedback domain's event bus subscriber (#179), as a pure factory
// (docs/reference/events.md#subscribing). `createEventBus` calls it; it never imports an
// instance.ts.
import { DomainEventTypes } from '@mocco/common/events';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { createShipDetector } from '@backend/domain/feedback/compose';

import type { EventBus } from '@backend/domain/events/EventBus';
import type { CommitAncestry } from '@backend/domain/integration/ports';
import type { Db } from '@backend/infra/db/types';

/** The ship detector's subscriber name. Permanent: it is in delivery dedupe keys and the ledger. */
export const SHIP_DETECT_SUBSCRIBER = 'feedback.ship_detect';

export interface FeedbackSubscriberDeps {
  db: Db;
  /** Answers whether a release contains a merge commit; undefined without a GitHub App. */
  ancestry?: CommitAncestry;
  now?: () => Date;
}

/** On `deploy.released`, suggest shipping the board posts the release contains. A failure throws,
 * so the delivery job retries (every write is idempotent). */
export function registerFeedbackSubscribers(bus: EventBus, deps: FeedbackSubscriberDeps): void {
  const detector = createShipDetector(deps.db, {
    audit: new AuditService({ audit: new AuditRepo(deps.db) }),
    ...(deps.ancestry !== undefined && { ancestry: deps.ancestry }),
    ...(deps.now !== undefined && { now: deps.now }),
  });
  bus.subscribe(DomainEventTypes.deployReleased, SHIP_DETECT_SUBSCRIBER, async event => {
    const { payload } = event;
    await detector.detect({
      workspaceId: event.workspaceId,
      runId: payload.runId,
      repoId: payload.repoId,
      projectIds: payload.projectIds,
      commitSha: payload.commitSha,
      gateNames: payload.gates.map(gate => gate.name),
      succeededSteps: payload.succeededSteps,
    });
  });
}
