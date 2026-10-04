// Production composition root for the status domain. Lazy so builds don't need env at import.
import { getAudit } from '@backend/domain/audit/instance';
import { getJobQueue } from '@backend/domain/jobs/instance';
import { createStatusDomain } from '@backend/domain/status/compose';
import { getDb } from '@backend/infra/db/client';

import type { StatusDomain } from '@backend/domain/status/compose';

const state: { status?: StatusDomain } = {};

export function getStatusDomain(): StatusDomain {
  state.status ??= createStatusDomain(getDb(), { audit: getAudit().audit, queue: getJobQueue() });
  return state.status;
}
