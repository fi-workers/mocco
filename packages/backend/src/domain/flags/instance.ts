// Production composition root for the flags domain. Lazy so builds don't need env at import.
import { getAudit } from '@backend/domain/audit/instance';
import { FlagService } from '@backend/domain/flags/FlagService';
import { getDb } from '@backend/infra/db/client';

export interface FlagsDomain {
  flags: FlagService;
}

const state: { flags?: FlagsDomain } = {};

export function getFlagsDomain(): FlagsDomain {
  if (!state.flags) {
    state.flags = { flags: new FlagService({ db: getDb(), audit: getAudit().audit }) };
  }
  return state.flags;
}
