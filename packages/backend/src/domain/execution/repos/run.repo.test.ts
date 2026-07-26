import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RunRepo } from '@backend/domain/execution/repos/run.repo';
import { EntityNotFoundError } from '@backend/infra/db/errors';
import { expectOne } from '@backend/infra/db/rows';
import { commitConfigs, commits, providerConnections, repos, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

interface Seed {
  workspaceId: string;
  commitId: string;
  commitConfigId: string;
}

function runValues(s: Seed) {
  return {
    workspaceId: s.workspaceId,
    commitId: s.commitId,
    commitConfigId: s.commitConfigId,
    callbackTokenHash: randomUUID(),
  };
}

describe('RunRepo (pglite)', () => {
  let t: TestDb;
  let runRepo: RunRepo;

  beforeEach(async () => {
    t = await createTestDb();
    runRepo = new RunRepo(t.db);
  });

  afterEach(async () => {
    await t.close();
  });

  async function seed(): Promise<Seed> {
    const workspaceId = expectOne(
      await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning(),
    ).id;
    const conn = expectOne(
      await t.db
        .insert(providerConnections)
        .values({ workspaceId, provider: 'github', externalAccountId: randomUUID(), accountLogin: 'acme' })
        .returning(),
    );
    const repoRow = expectOne(
      await t.db
        .insert(repos)
        .values({
          workspaceId,
          connectionId: conn.id,
          externalRepoId: randomUUID(),
          owner: 'o',
          name: 'n',
          defaultBranch: 'main',
        })
        .returning(),
    );
    const commitId = expectOne(
      await t.db
        .insert(commits)
        .values({
          repoId: repoRow.id,
          sha: randomUUID(),
          branch: 'main',
          message: 'initial message',
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
    return { workspaceId, commitId, commitConfigId };
  }

  it('create inserts and returns the run row', async () => {
    const s = await seed();
    const run = await runRepo.create(runValues(s));

    expect(run.id).toBeDefined();
    expect(run.workspaceId).toBe(s.workspaceId);
    expect(run.commitId).toBe(s.commitId);
    expect(run.commitConfigId).toBe(s.commitConfigId);
    // Defaults apply on insert.
    expect(run.state).toBe('queued');
    expect(run.currentIndex).toBe(0);
    expect(run.triggerSource).toBe('manual');
    expect(run.triggeredByUserId).toBeNull();
    expect(run.startedAt).toBeNull();
    expect(run.finishedAt).toBeNull();
  });

  it('getByIdInWorkspace returns a run owned by the workspace', async () => {
    const s = await seed();
    const created = await runRepo.create(runValues(s));

    const found = await runRepo.getByIdInWorkspace(s.workspaceId, created.id);
    expect(found.id).toBe(created.id);
  });

  it('getByIdInWorkspace throws EntityNotFoundError for a run owned by a different workspace', async () => {
    const s = await seed();
    const foreign = await seed();
    const created = await runRepo.create(runValues(s));

    await expect(runRepo.getByIdInWorkspace(foreign.workspaceId, created.id)).rejects.toBeInstanceOf(
      EntityNotFoundError,
    );
  });

  it('getByIdInWorkspace throws EntityNotFoundError for an unknown run id', async () => {
    const s = await seed();
    await expect(runRepo.getByIdInWorkspace(s.workspaceId, randomUUID())).rejects.toBeInstanceOf(EntityNotFoundError);
  });

  it('findByCommit returns runs for the commit newest-first, scoped to the workspace', async () => {
    const s = await seed();
    const first = await runRepo.create(runValues(s));
    const second = await runRepo.create(runValues(s));

    const rows = await runRepo.findByCommit(s.workspaceId, s.commitId);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map(r => r.id))).toEqual(new Set([first.id, second.id]));

    // A different workspace sees none of them.
    const foreign = await seed();
    expect(await runRepo.findByCommit(foreign.workspaceId, s.commitId)).toHaveLength(0);
  });
});
