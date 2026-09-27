// Production composition root for publishing domain events (ADR 0018). Lazy so builds
// don't need env at import. Publishers (execution, governance) inject `getEventBus()` into
// their services. The subscriber list lives in the pure `createEventBus`, shared with the
// job runner (runtime/jobs.ts), so a publishing lambda and a delivering tick agree on it.
import { createEventBus } from '@backend/domain/events/subscriptions';
import { resolveBaseOrigin } from '@backend/domain/execution/endpoints';
import { getJobQueue } from '@backend/domain/jobs/instance';
import { getEnv } from '@backend/infra/config/env';
import { getDb } from '@backend/infra/db/client';

import type { EventBus } from '@backend/domain/events/EventBus';

const state: { bus?: EventBus } = {};

/** The event bus with every subscriber registered. Always available. */
export function getEventBus(): EventBus {
  if (!state.bus) {
    const env = getEnv();
    state.bus = createEventBus({
      db: getDb(),
      queue: getJobQueue(),
      now: () => new Date(),
      appOrigin: resolveBaseOrigin({ serviceDomain: env.SERVICE_DOMAIN, vercelUrl: env.VERCEL_URL }),
    });
  }
  return state.bus;
}
