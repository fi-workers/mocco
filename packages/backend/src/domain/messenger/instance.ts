// Production composition root for the messenger. Lazy so builds don't need env at import.
import { getAudit } from '@backend/domain/audit/instance';
import { getEventBus } from '@backend/domain/events/instance';
import { resolveBaseOrigin } from '@backend/domain/execution/endpoints';
import { createMessengerDomain } from '@backend/domain/messenger/compose';
import { getStorageDomain } from '@backend/domain/storage/instance';
import { getEnv } from '@backend/infra/config/env';
import { getSecretBox } from '@backend/infra/crypto/instance';
import { getDb } from '@backend/infra/db/client';

import type { MessengerDomain } from '@backend/domain/messenger/compose';

const state: { messenger?: MessengerDomain } = {};

export function getMessengerDomain(): MessengerDomain {
  state.messenger ??= createMessengerDomain(getDb(), {
    audit: getAudit().audit,
    box: getSecretBox,
    storage: getStorageDomain()?.storage,
    events: getEventBus(),
    appOrigin: resolveBaseOrigin({ serviceDomain: getEnv().SERVICE_DOMAIN, vercelUrl: getEnv().VERCEL_URL }),
  });
  return state.messenger;
}
