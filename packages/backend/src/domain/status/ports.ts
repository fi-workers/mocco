// What the status domain reads from elsewhere. Status depends on execution and the release
// registry, never the reverse: the composition root (compose.ts) implements these ports over
// their repos, so neither domain imports status.

/** A recorded release of a run (docs/reference/releases.md), as correlation sees it. */
export interface DeployRelease {
  runId: string;
  projectId: string;
  releasedAt: Date;
}

/** What the incident's "Recent deploys" list shows about a run. */
export interface RunSummary {
  runId: string;
  state: string;
  repoFullName: string;
  commitSha: string;
  finishedAt: Date | null;
}

/** The deploys an incident is correlated with: recorded releases, and the runs behind them. */
export interface DeploySource {
  /** Whether the project links at least one repository. */
  projectHasRepos(workspaceId: string, projectId: string): Promise<boolean>;
  /** Releases between `from` and `to`: of `projectId`'s linked repos when given, else the workspace's. */
  releasesBetween(
    workspaceId: string,
    window: { from: Date; to: Date; projectId?: string },
  ): Promise<readonly DeployRelease[]>;
  /** The workspace's runs among `runIds`; another workspace's ids are left out. */
  runSummaries(workspaceId: string, runIds: readonly string[]): Promise<readonly RunSummary[]>;
}

/** An event status adds to a run's timeline (`mocco_run_events`). */
export interface RunTimelineEvent {
  type: string;
  payload: Record<string, unknown>;
}

/** Where status writes on a run: only its timeline. A run's state is never changed from here
 * (an automatic rollback on a failed post-deploy check would need its own ADR). */
export interface RunTimeline {
  /** Append to the run's timeline; false (and nothing written) when the run isn't the workspace's. */
  append(workspaceId: string, runId: string, event: RunTimelineEvent): Promise<boolean>;
}
