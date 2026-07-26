// Production composition root for the execution domain. Lazy so builds don't need
// env at import. Unlike integration (gated on the GitHub App env), execution has
// NO external dependency — it is always available, so `getExecution()` never
// returns undefined and the tRPC context carries it non-optionally.
import { waitUntil } from '@vercel/functions';

import { callbackUrlFrom, genericExecutorUrlFrom, resolveBaseOrigin } from '@backend/domain/execution/endpoints';
import { GenericExecutor } from '@backend/domain/execution/executors/generic/provider';
import { postJson } from '@backend/domain/execution/http';
import { RunEventRepo } from '@backend/domain/execution/repos/run-event.repo';
import { RunStepRepo } from '@backend/domain/execution/repos/run-step.repo';
import { RunRepo } from '@backend/domain/execution/repos/run.repo';
import { RunService } from '@backend/domain/execution/RunService';
import { CommitConfigRepo } from '@backend/domain/integration/repos/commit-config.repo';
import { CommitRepo } from '@backend/domain/integration/repos/commit.repo';
import { getEnv } from '@backend/infra/config/env';
import { getDb } from '@backend/infra/db/client';

export interface Execution {
  runs: RunService;
  /** This deployment's own callback URL. The ext `/executor/generic` route uses it
   * instead of the (untrusted) `callbackUrl` in the request body — see the SSRF note there. */
  callbackUrl: string;
}

const state: { execution?: Execution } = {};

/** The execution services. Always available (no external dependency to gate on). */
export function getExecution(): Execution {
  if (!state.execution) {
    const db = getDb();
    const env = getEnv();
    // The app's own origin — both the callback URL (where executors report back) and
    // the generic executor's trigger URL loop back to THIS deployment.
    const baseOrigin = resolveBaseOrigin({ serviceDomain: env.SERVICE_DOMAIN, vercelUrl: env.VERCEL_URL });
    const callbackUrl = callbackUrlFrom(baseOrigin);
    state.execution = {
      runs: new RunService({
        runs: new RunRepo(db),
        steps: new RunStepRepo(db),
        events: new RunEventRepo(db),
        commits: new CommitRepo(db),
        configs: new CommitConfigRepo(db),
        executor: new GenericExecutor({ endpoint: genericExecutorUrlFrom(baseOrigin), post: postJson }),
        callbackUrl,
        waitUntil,
      }),
      callbackUrl,
    };
  }
  return state.execution;
}
