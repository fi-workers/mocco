// Production composition root for publishing domain events (ADR 0018). Lazy so builds
// don't need env at import. Publishers (execution, governance) inject `getEventBus()` into
// their services. The subscriber list lives in the pure `createEventBus`, shared with the
// job runner (runtime/jobs.ts), so a publishing lambda and a delivering tick agree on it.
import { createEventBus } from '@backend/domain/events/subscriptions';
import { resolveBaseOrigin } from '@backend/domain/execution/endpoints';
import { getJobQueue } from '@backend/domain/jobs/instance';
import { stage0CanaryMatcher } from '@backend/domain/ops/canary';
import { stage0ConfigFromEnv } from '@backend/domain/ops/config';
import { getEnv } from '@backend/infra/config/env';
import { getDb } from '@backend/infra/db/client';

import type { EventBus } from '@backend/domain/events/EventBus';

const state: { bus?: EventBus } = {};

/** The event bus with every subscriber registered. Always available. */
export function getEventBus(): EventBus {
  if (!state.bus) {
    const env = getEnv();
    const stage0 = stage0ConfigFromEnv(env);
    state.bus = createEventBus({
      db: getDb(),
      queue: getJobQueue(),
      now: () => new Date(),
      appOrigin: resolveBaseOrigin({ serviceDomain: env.SERVICE_DOMAIN, vercelUrl: env.VERCEL_URL }),
      // Fan-out runs in the job runtime, which marks canaries itself; this keeps the
      // two roots' buses identical.
      isCanary: stage0 === undefined ? undefined : stage0CanaryMatcher(stage0.canarySourceId),
    });
  }
  return state.bus;
}
