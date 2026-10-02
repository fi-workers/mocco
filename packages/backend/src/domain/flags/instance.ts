// Production composition root for the flags domain. Lazy so builds don't need env at
// import. Binding the changeset approval handlers on the shared approval service keeps
// the dependency one-way (flags → governance).
import { getAudit } from '@backend/domain/audit/instance';
import { getEventBus } from '@backend/domain/events/instance';
import { resolveBaseOrigin } from '@backend/domain/execution/endpoints';
import { createFlagsDomain } from '@backend/domain/flags/compose';
import { getGovernance } from '@backend/domain/governance/instance';
import { getEnv } from '@backend/infra/config/env';
import { getDb } from '@backend/infra/db/client';

import type { FlagsDomain } from '@backend/domain/flags/compose';

const state: { flags?: FlagsDomain } = {};

export function getFlagsDomain(): FlagsDomain {
  if (!state.flags) {
    state.flags = createFlagsDomain(getDb(), {
      audit: getAudit().audit,
      approvals: getGovernance().approvals,
      events: getEventBus(),
      appOrigin: resolveBaseOrigin({ serviceDomain: getEnv().SERVICE_DOMAIN, vercelUrl: getEnv().VERCEL_URL }),
    });
  }
  return state.flags;
}
