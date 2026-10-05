// Test-only: repos, runs and releases for deploy-correlation tests, written through the
// execution and release repos. Not imported by production code.
import { randomUUID } from 'node:crypto';

import { RunStates } from '@mocco/common/execution';

import { RunRepo } from '@backend/domain/execution/repos/run.repo';
import { ReleaseRepo } from '@backend/domain/project/repos/release.repo';
import { expectOne } from '@backend/infra/db/rows';
import { commitConfigs, commits, projectRepos, providerConnections, repos } from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';
import type { RunState } from '@mocco/common/execution';

/** A repo of the workspace (on its own provider connection), linked to `projectIds`. */
export async function seedRepo(db: Db, workspaceId: string, name: string, projectIds: readonly string[] = []) {
  const connection = expectOne(
    await db
      .insert(providerConnections)
      .values({ workspaceId, provider: 'github', externalAccountId: randomUUID(), accountLogin: 'acme' })
      .returning(),
  );
  const repo = expectOne(
    await db
      .insert(repos)
      .values({
        workspaceId,
        connectionId: connection.id,
        externalRepoId: randomUUID(),
        owner: 'acme',
        name,
        defaultBranch: 'main',
      })
      .returning(),
  );
  await Promise.all(
    projectIds.map(
      async projectId => await db.insert(projectRepos).values({ workspaceId, projectId, repoId: repo.id }),
    ),
  );
  return repo.id;
}

/** A run of a fresh commit on `repoId`, finished at `finishedAt` in `state` (succeeded by default). */
export async function seedRun(
  db: Db,
  input: { workspaceId: string; repoId: string; finishedAt: Date; state?: RunState },
): Promise<{ runId: string; sha: string }> {
  const sha = `sha-${randomUUID()}`;
  const commit = expectOne(
    await db
      .insert(commits)
      .values({
        repoId: input.repoId,
        sha,
        branch: 'main',
        message: 'msg',
        authorName: 'Author',
        authorEmail: 'author@example.com',
        committedAt: input.finishedAt,
      })
      .returning(),
  );
  const config = expectOne(
    await db
      .insert(commitConfigs)
      .values({
        commitId: commit.id,
        present: true,
        rawYaml: 'version: 2',
        parsedJson: { version: 2, pipeline: 'deploy', steps: [] },
        valid: true,
        validationErrors: [],
      })
      .returning(),
  );
  const run = await new RunRepo(db).create({
    workspaceId: input.workspaceId,
    commitId: commit.id,
    commitConfigId: config.id,
    state: input.state ?? RunStates.succeeded,
    callbackTokenHash: randomUUID(),
    startedAt: input.finishedAt,
    finishedAt: input.finishedAt,
  });
  return { runId: run.id, sha };
}

/** A succeeded run recorded as a release of `projectIds` (the registry's row per project). */
export async function seedRelease(
  db: Db,
  input: { workspaceId: string; repoId: string; projectIds: readonly string[]; releasedAt: Date },
): Promise<string> {
  const { runId, sha } = await seedRun(db, { ...input, finishedAt: input.releasedAt });
  await new ReleaseRepo(db).insertMissing(
    input.projectIds.map(projectId => ({
      workspaceId: input.workspaceId,
      projectId,
      runId,
      repoId: input.repoId,
      commitSha: sha,
      gates: [],
      releasedAt: input.releasedAt,
    })),
  );
  return runId;
}
