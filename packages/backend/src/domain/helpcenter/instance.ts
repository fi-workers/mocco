// Production composition root for the help center. Lazy so builds don't need env at import.
import { getAudit } from '@backend/domain/audit/instance';
import { createHelpDomain } from '@backend/domain/helpcenter/compose';
import { getDb } from '@backend/infra/db/client';

import type { HelpDomain } from '@backend/domain/helpcenter/compose';

const state: { help?: HelpDomain } = {};

export function getHelpDomain(): HelpDomain {
  state.help ??= createHelpDomain(getDb(), { audit: getAudit().audit });
  return state.help;
}
