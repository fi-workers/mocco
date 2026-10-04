import { createHash } from 'node:crypto';

// Production composition root for the flags domain. Lazy so builds don't need env at
// import. Binding the changeset approval handlers on the shared approval service keeps
// the dependency one-way (flags → governance).
import { getAudit } from '@backend/domain/audit/instance';
import { getEventBus } from '@backend/domain/events/instance';
import { resolveBaseOrigin } from '@backend/domain/execution/endpoints';
import { createFlagsDomain } from '@backend/domain/flags/compose';
import { FlagFileSyncService } from '@backend/domain/flags/FlagFileSyncService';
import { FlagPlanCheckService } from '@backend/domain/flags/FlagPlanCheckService';
import { StreamTokens } from '@backend/domain/flags/stream-token';
import { getGovernance } from '@backend/domain/governance/instance';
import { getIntegration } from '@backend/domain/integration/instance';
import { getEnv } from '@backend/infra/config/env';
import { getDb } from '@backend/infra/db/client';

import type { FlagsDomain } from '@backend/domain/flags/compose';
import type { CheckPublisher, RepoFileSource } from '@backend/domain/integration/ports';
import type { Env } from '@backend/infra/config/env';

const state: { flags?: FlagsDomain } = {};

export function getFlagsDomain(): FlagsDomain {
  if (!state.flags) {
    // Without the GitHub App, the deploy-aware warning answers unknown.
    const archives = getIntegration()?.provider;
    state.flags = createFlagsDomain(getDb(), {
      audit: getAudit().audit,
      approvals: getGovernance().approvals,
      events: getEventBus(),
      appOrigin: resolveBaseOrigin({ serviceDomain: getEnv().SERVICE_DOMAIN, vercelUrl: getEnv().VERCEL_URL }),
      ...(archives !== undefined && { archives }),
    });
  }
  return state.flags;
}

/** The `.mocco/flags.yml` sync (#145) over the production flags domain, reading files through `files`. */
export function getFlagFiles(files: RepoFileSource): FlagFileSyncService {
  const { flags, flagGovernance } = getFlagsDomain();
  return new FlagFileSyncService({ db: getDb(), audit: getAudit().audit, flags, governance: flagGovernance, files });
}

/** The flags plan check on pull requests (#146), reading files and publishing checks through `github`. */
export function getFlagPlanChecks(github: RepoFileSource & CheckPublisher): FlagPlanCheckService {
  return new FlagPlanCheckService({ db: getDb(), files: github, checks: github });
}

/** Stream tokens signed with a key derived from AUTH_SECRET; undefined without one (OFREP
 * then advertises no event stream and clients poll). */
export function flagStreamTokensFromEnv(env: Env): StreamTokens | undefined {
  return env.AUTH_SECRET === undefined
    ? undefined
    : new StreamTokens(createHash('sha256').update(`mocco-flags-stream:${env.AUTH_SECRET}`).digest('hex'));
}
