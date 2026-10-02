// The project-scoped run reads (/v1/runs). A run carries no project: it reaches one
// through its commit's repository and `mocco_project_repos`, so these tests exist mainly
// to pin the scoping — a key must not reach a run under a repository its project does not
// link, even inside its own workspace.
import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RunRepo } from '@backend/domain/execution/repos/run.repo';
import { expectOne } from '@backend/infra/db/rows';
import {
  commitConfigs,
  commits,
  projectRepos,
  projects,
  providerConnections,
  repos,
  workspaces,
} from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

const PAGE = { limit: 20 };

describe('RunRepo project-scoped reads (pglite)', () => {
  let t: TestDb;
  let runRepo: RunRepo;

  beforeEach(async () => {
    t = await createTestDb();
    runRepo = new RunRepo(t.db);
  });
  afterEach(async () => {
    await t.close();
  });

  /** A workspace with one project and one repository linked to it. */
  /** A repository in `workspaceId`, linked to `projectId` when one is given. */
  async function addRepo(workspaceId: string, projectId?: string) {
    const connection = expectOne(
      await t.db
        .insert(providerConnections)
        .values({ workspaceId, provider: 'github', externalAccountId: randomUUID(), accountLogin: 'acme' })
        .returning(),
    );
    const repoId = expectOne(
      await t.db
        .insert(repos)
        .values({
          workspaceId,
          connectionId: connection.id,
          externalRepoId: randomUUID(),
          owner: 'o',
          name: randomUUID().slice(0, 8),
          defaultBranch: 'main',
        })
        .returning(),
    ).id;
    if (projectId !== undefined) {
      await t.db.insert(projectRepos).values({ workspaceId, projectId, repoId });
    }
    return repoId;
  }

  async function seedProject() {
    const workspaceId = expectOne(
      await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning(),
    ).id;
    const projectId = expectOne(
      await t.db
        .insert(projects)
        .values({ workspaceId, name: 'Acme', handle: randomUUID().slice(0, 8) })
        .returning(),
    ).id;
    const repoId = await addRepo(workspaceId, projectId);
    return { workspaceId, projectId, repoId };
  }

  /** A run on `repoId`, with its commit and pinned config. */
  async function addRun(workspaceId: string, repoId: string, overrides: { state?: 'queued' | 'awaiting_gate' } = {}) {
    const commitId = expectOne(
      await t.db
        .insert(commits)
        .values({
          repoId,
          sha: randomUUID(),
          branch: 'main',
          message: 'a commit',
          authorName: 'Author',
          authorEmail: 'author@example.com',
          committedAt: new Date('2026-01-01T00:00:00Z'),
        })
        .returning(),
    ).id;
    const commitConfigId = expectOne(
      await t.db
        .insert(commitConfigs)
        .values({ commitId, rawYaml: 'version: 1', parsedJson: { version: 1 }, valid: true })
        .returning(),
    ).id;
    return await runRepo.create({
      workspaceId,
      commitId,
      commitConfigId,
      callbackTokenHash: randomUUID(),
      ...overrides,
    });
  }

  it('finds the runs of the repositories the project links', async () => {
    const { workspaceId, projectId, repoId } = await seedProject();
    const run = await addRun(workspaceId, repoId);

    const found = await runRepo.searchInProject(workspaceId, projectId, PAGE);

    expect(found.map(row => row.run.id)).toEqual([run.id]);
    expect(found[0]?.repo.id).toBe(repoId);
    expect(found[0]?.commit.branch).toBe('main');
  });

  it('does not reach a run under a repository the project does not link', async () => {
    const { workspaceId, projectId } = await seedProject();
    // Same workspace, same tenant — but never linked to this project.
    const otherRepoId = await addRepo(workspaceId);
    const hidden = await addRun(workspaceId, otherRepoId);

    const found = await runRepo.searchInProject(workspaceId, projectId, PAGE);

    expect(found.map(row => row.run.id)).not.toContain(hidden.id);
    expect(await runRepo.findInProject(workspaceId, projectId, hidden.id)).toBeUndefined();
  });

  it('does not reach another workspace, even with the right project id', async () => {
    const mine = await seedProject();
    const theirs = await seedProject();
    const theirRun = await addRun(theirs.workspaceId, theirs.repoId);

    // The workspace is checked as well as the project, so a leaked project id is not enough.
    expect(await runRepo.findInProject(mine.workspaceId, theirs.projectId, theirRun.id)).toBeUndefined();
    expect(await runRepo.searchInProject(mine.workspaceId, theirs.projectId, PAGE)).toEqual([]);
  });

  it('filters by state, so "what is waiting" is one call', async () => {
    const { workspaceId, projectId, repoId } = await seedProject();
    await addRun(workspaceId, repoId);
    const paused = await addRun(workspaceId, repoId, { state: 'awaiting_gate' });

    const found = await runRepo.searchInProject(workspaceId, projectId, { ...PAGE, state: 'awaiting_gate' });

    expect(found.map(row => row.run.id)).toEqual([paused.id]);
  });

  it('filters by repository', async () => {
    const { workspaceId, projectId, repoId } = await seedProject();
    const secondRepoId = await addRepo(workspaceId, projectId);
    await addRun(workspaceId, repoId);
    const onSecond = await addRun(workspaceId, secondRepoId);

    const found = await runRepo.searchInProject(workspaceId, projectId, { ...PAGE, repoId: secondRepoId });

    expect(found.map(row => row.run.id)).toEqual([onSecond.id]);
  });

  it('pages newest first, and `before` continues from the last row', async () => {
    const { workspaceId, projectId, repoId } = await seedProject();
    await addRun(workspaceId, repoId);
    await addRun(workspaceId, repoId);
    await addRun(workspaceId, repoId);

    const first = await runRepo.searchInProject(workspaceId, projectId, { limit: 2 });
    expect(first).toHaveLength(2);
    expect(first[0]?.run.createdAt.getTime()).toBeGreaterThanOrEqual(first[1]?.run.createdAt.getTime() ?? 0);

    const next = await runRepo.searchInProject(workspaceId, projectId, {
      limit: 2,
      before: first.at(-1)?.run.createdAt,
    });

    expect(next.map(row => row.run.id)).not.toContain(first[0]?.run.id);
    expect(next.length).toBeLessThanOrEqual(1);
  });

  it('returns a run with the config it pinned', async () => {
    const { workspaceId, projectId, repoId } = await seedProject();
    const run = await addRun(workspaceId, repoId);

    const found = await runRepo.findInProject(workspaceId, projectId, run.id);

    expect(found?.run.id).toBe(run.id);
    expect(found?.config.rawYaml).toBe('version: 1');
  });

  it('returns undefined for an unknown id rather than throwing', async () => {
    const { workspaceId, projectId } = await seedProject();

    expect(await runRepo.findInProject(workspaceId, projectId, randomUUID())).toBeUndefined();
  });
});
