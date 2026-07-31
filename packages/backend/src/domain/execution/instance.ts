// Production composition root for the execution domain. Lazy so builds don't need
// env at import. Unlike integration (gated on the GitHub App env), execution has
// NO external dependency — it is always available, so `getExecution()` never
// returns undefined and the tRPC context carries it non-optionally.
import { ExecutorIds } from '@mocco/common/execution';
import { waitUntil } from '@vercel/functions';

import { getAudit } from '@backend/domain/audit/instance';
import { callbackUrlFrom, genericExecutorUrlFrom, resolveBaseOrigin } from '@backend/domain/execution/endpoints';
import { GenericExecutor } from '@backend/domain/execution/executors/generic/provider';
import { GitHubExecutor } from '@backend/domain/execution/executors/github/provider';
import { postJson } from '@backend/domain/execution/http';
import { RunEventRepo } from '@backend/domain/execution/repos/run-event.repo';
import { RunStepRepo } from '@backend/domain/execution/repos/run-step.repo';
import { RunRepo } from '@backend/domain/execution/repos/run.repo';
import { RunService } from '@backend/domain/execution/RunService';
import { ResumeRepo } from '@backend/domain/governance/repos/resume.repo';
import { RunGateRepo } from '@backend/domain/governance/repos/run-gate.repo';
import { getIntegration } from '@backend/domain/integration/instance';
import { CommitConfigRepo } from '@backend/domain/integration/repos/commit-config.repo';
import { CommitRepo } from '@backend/domain/integration/repos/commit.repo';
import { ProviderConnectionRepo } from '@backend/domain/integration/repos/provider-connection.repo';
import { RepoRepo } from '@backend/domain/integration/repos/repo.repo';
import { getEnv } from '@backend/infra/config/env';
import { getDb } from '@backend/infra/db/client';

import type { Executor } from '@backend/domain/execution/ports';

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
    // The executor registry (ADR 0004). The generic adapter is always registered;
    // the GitHub adapter is added only when the GitHub App is configured (below).
    // A step whose `executor` id is absent here fails its run closed
    // (RunService.startExecutor → failStepAndRun) — never a silent no-op.
    const executors = new Map<string, Executor>([
      [ExecutorIds.generic, new GenericExecutor({ endpoint: genericExecutorUrlFrom(baseOrigin), post: postJson })],
    ]);
    // When GitHub is wired (getIntegration present), register the GitHub Actions
    // adapter. It dispatches through the integration provider's neutral
    // RepositoryDispatcher port (octokit stays isolated there) and resolves a run's
    // repo + installation through these repos. Absent GitHub config → a
    // `github-actions` step fails closed (PR1).
    const integration = getIntegration();
    if (integration !== undefined) {
      executors.set(
        ExecutorIds.githubActions,
        new GitHubExecutor({
          dispatcher: integration.provider,
          runs: new RunRepo(db),
          commits: new CommitRepo(db),
          repos: new RepoRepo(db),
          connections: new ProviderConnectionRepo(db),
        }),
      );
    }
    state.execution = {
      runs: new RunService({
        runs: new RunRepo(db),
        steps: new RunStepRepo(db),
        events: new RunEventRepo(db),
        runGates: new RunGateRepo(db),
        resumes: new ResumeRepo(db),
        commits: new CommitRepo(db),
        configs: new CommitConfigRepo(db),
        executors,
        callbackUrl,
        waitUntil,
        audit: getAudit().audit,
      }),
      callbackUrl,
    };
  }
  return state.execution;
}
