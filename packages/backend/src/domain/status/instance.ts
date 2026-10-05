// Production composition root for the status domain. Lazy so builds don't need env at import.
import { getAudit } from '@backend/domain/audit/instance';
import { getEventBus } from '@backend/domain/events/instance';
import { resolveBaseOrigin } from '@backend/domain/execution/endpoints';
import { getJobQueue } from '@backend/domain/jobs/instance';
import { createStatusDomain } from '@backend/domain/status/compose';
import { getEnv } from '@backend/infra/config/env';
import { getDb } from '@backend/infra/db/client';

import type { StatusDomain } from '@backend/domain/status/compose';

const state: { status?: StatusDomain } = {};

export function getStatusDomain(): StatusDomain {
  if (!state.status) {
    const env = getEnv();
    state.status = createStatusDomain(getDb(), {
      audit: getAudit().audit,
      queue: getJobQueue(),
      events: getEventBus(),
      appOrigin: resolveBaseOrigin({ serviceDomain: env.SERVICE_DOMAIN, vercelUrl: env.VERCEL_URL }),
    });
  }
  return state.status;
}
