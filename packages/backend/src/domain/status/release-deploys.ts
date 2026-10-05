// The DeploySource and RunTimeline ports over the release registry and the execution repos.
// Built by the composition root (compose.ts); the status services only see the ports.
import { RunEventRepo } from '@backend/domain/execution/repos/run-event.repo';
import { RunRepo } from '@backend/domain/execution/repos/run.repo';
import { ProjectRepoRepo } from '@backend/domain/project/repos/project-repo.repo';
import { ReleaseRepo } from '@backend/domain/project/repos/release.repo';

import type { DeploySource, RunTimeline } from '@backend/domain/status/ports';
import type { Db } from '@backend/infra/db/types';

export function createReleaseDeploySource(db: Db): DeploySource {
  const releases = new ReleaseRepo(db);
  const runs = new RunRepo(db);
  const projectRepos = new ProjectRepoRepo(db);
  return {
    projectHasRepos: async (workspaceId, projectId) => {
      const links = await projectRepos.listByProject(workspaceId, projectId);
      return links.length > 0;
    },
    releasesBetween: async (workspaceId, window) => {
      const rows = await releases.listReleasedBetween(workspaceId, window);
      return rows.flatMap(release =>
        release.runId === null
          ? []
          : [{ runId: release.runId, projectId: release.projectId, releasedAt: release.releasedAt }],
      );
    },
    runSummaries: async (workspaceId, runIds) => {
      const rows = await runs.listWithRepoInWorkspace(workspaceId, runIds);
      return rows.map(({ run, commit, repo }) => ({
        runId: run.id,
        state: run.state,
        repoFullName: `${repo.owner}/${repo.name}`,
        commitSha: commit.sha,
        finishedAt: run.finishedAt,
      }));
    },
  };
}

/** Appends to a run's timeline through the execution domain's event repo; never touches the run. */
export function createRunTimeline(db: Db): RunTimeline {
  const runs = new RunRepo(db);
  const events = new RunEventRepo(db);
  return {
    append: async (workspaceId, runId, event) => {
      const [found] = await runs.listWithRepoInWorkspace(workspaceId, [runId]);
      if (found === undefined) {
        return false;
      }
      await events.append({ workspaceId, runId, type: event.type, payload: event.payload });
      return true;
    },
  };
}
