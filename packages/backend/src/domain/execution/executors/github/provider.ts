// The GitHub Actions executor adapter (ADR 0004). A step whose `executor` id is
// `github-actions` is dispatched here: resolve the run's repo + installation, then
// fire a `repository_dispatch` at that repo so the workflow runs in GitHub Actions
// and reports back over the SAME neutral /api/ext/callback the generic executor
// uses (carrying the per-run token in the client_payload). Vendor-coupled by design
// (ADR 0004), but it NEVER imports octokit — the vendor call goes through the
// neutral RepositoryDispatcher port (the integration GitHub provider implements it,
// keeping octokit isolated to that one file). Fire-and-forget: enforcement is the
// callback, never this trigger.
import type { Executor, RunStepDispatch } from '@backend/domain/execution/ports';
import type { RunRepo } from '@backend/domain/execution/repos/run.repo';
import type { RepositoryDispatcher } from '@backend/domain/integration/ports';
import type { CommitRepo } from '@backend/domain/integration/repos/commit.repo';
import type { ProviderConnectionRepo } from '@backend/domain/integration/repos/provider-connection.repo';
import type { RepoRepo } from '@backend/domain/integration/repos/repo.repo';
import type { DispatchContext } from '@mocco/common/execution';

/** The fixed `repository_dispatch` event type every mocco run step dispatches under
 * — the workflow filters on it (`on: repository_dispatch: types: [mocco-run-step]`).
 * A module constant (not configurable via `with`) until a repo needs multiple mocco
 * workflows (spec §7 open question — default to the constant). */
export const GITHUB_RUN_STEP_EVENT_TYPE = 'mocco-run-step';

export interface GitHubExecutorDeps {
  /** The neutral repository_dispatch seam (prod = the integration GitHub provider,
   * which owns octokit + installation-token minting; tests inject a recorder). */
  dispatcher: RepositoryDispatcher;
  /** Resolve `ctx.runId` → run (workspace-agnostic; the executor only has the run id). */
  runs: RunRepo;
  /** run.commitId → commit (sha + repoId), workspace-scoped by the resolved run. */
  commits: CommitRepo;
  /** commit.repoId → repo (owner/name + connectionId). */
  repos: RepoRepo;
  /** repo.connectionId → connection (externalAccountId = installation id). */
  connections: ProviderConnectionRepo;
}

export class GitHubExecutor implements Executor {
  constructor(private readonly deps: GitHubExecutorDeps) {}

  /** Resolve the run → commit → repo → connection chain, then fire a
   * repository_dispatch carrying the callback context + commit SHA. The `dispatch`
   * step detail is unused here (the workflow reads its step from the client_payload).
   * Returns an opaque handle naming the target repo + step. */
  async start(_dispatch: RunStepDispatch, ctx: DispatchContext): Promise<{ handle: string }> {
    const run = await this.deps.runs.findById(ctx.runId);
    if (run === undefined) {
      // The run is created and committed before its step is dispatched — a missing
      // run here is an invariant breach, not a normal miss.
      throw new Error(`run ${ctx.runId} was not found`);
    }
    const commit = await this.deps.commits.getByIdInWorkspace(run.workspaceId, run.commitId);
    const repo = await this.deps.repos.getByIdInWorkspace(run.workspaceId, commit.repoId);
    const connection = await this.deps.connections.getById(run.workspaceId, repo.connectionId);

    await this.deps.dispatcher.dispatch(
      { externalAccountId: connection.externalAccountId, owner: repo.owner, name: repo.name },
      GITHUB_RUN_STEP_EVENT_TYPE,
      {
        runId: ctx.runId,
        stepIndex: ctx.stepIndex,
        commitSha: commit.sha,
        callbackUrl: ctx.callbackUrl,
        callbackToken: ctx.callbackToken,
      },
    );

    return { handle: `github:${repo.owner}/${repo.name}:${ctx.runId}:${ctx.stepIndex}` };
  }
}
