// Production composition root for the help center. Lazy so builds don't need env at import.
import { getAudit } from '@backend/domain/audit/instance';
import { createHelpDomain } from '@backend/domain/helpcenter/compose';
import { translatorFromEnv } from '@backend/domain/helpcenter/translate/ai-gateway';
import { getJobQueue } from '@backend/domain/jobs/instance';
import { getStorageDomain } from '@backend/domain/storage/instance';
import { getEnv } from '@backend/infra/config/env';
import { getDb } from '@backend/infra/db/client';

import type { HelpDomain } from '@backend/domain/helpcenter/compose';

const state: { help?: HelpDomain } = {};

export function getHelpDomain(): HelpDomain {
  const storage = getStorageDomain()?.storage;
  const translator = translatorFromEnv(getEnv());
  state.help ??= createHelpDomain(getDb(), {
    audit: getAudit().audit,
    queue: getJobQueue(),
    ...(storage !== undefined && { storage }),
    ...(translator !== undefined && { translator }),
  });
  return state.help;
}
