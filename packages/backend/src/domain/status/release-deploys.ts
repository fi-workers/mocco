// The DeploySource port over the release registry and the execution repos. Built by the
// composition root (compose.ts); the status services only see the port.
import { RunRepo } from '@backend/domain/execution/repos/run.repo';
import { ProjectRepoRepo } from '@backend/domain/project/repos/project-repo.repo';
import { ReleaseRepo } from '@backend/domain/project/repos/release.repo';

import type { DeploySource } from '@backend/domain/status/ports';
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
