import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CommitConfigRepo } from '@backend/domain/integration/repos/commit-config.repo';
import { commitConfigs, commits, providerConnections, repos, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

function one<T>(rows: T[]): T {
  const [row] = rows;
  if (row === undefined) {
    throw new Error('expected one row');
  }
  return row;
}

describe('CommitConfigRepo (pglite)', () => {
  let t: TestDb;
  let commitConfigRepo: CommitConfigRepo;

  beforeEach(async () => {
    t = await createTestDb();
    commitConfigRepo = new CommitConfigRepo(t.db);
  });

  afterEach(async () => {
    await t.close();
  });

  async function seedCommit(): Promise<string> {
    const workspaceId = one(await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning()).id;
    const conn = one(
      await t.db
        .insert(providerConnections)
        .values({ workspaceId, provider: 'github', externalAccountId: randomUUID(), accountLogin: 'acme' })
        .returning(),
    );
    const repoRow = one(
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
    return one(
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
  }

  it('upsert overwrites the existing row on a repeated commit_id (re-snapshot)', async () => {
    const commitId = await seedCommit();

    await commitConfigRepo.upsert({
      commitId,
      rawYaml: 'version: 1',
      parsedJson: { version: 1 },
      valid: true,
      validationErrors: [],
    });
    await commitConfigRepo.upsert({
      commitId,
      rawYaml: 'version: 2 # broken',
      parsedJson: null,
      valid: false,
      validationErrors: ['unexpected key'],
    });

    const row = await commitConfigRepo.findByCommitId(commitId);
    expect(row?.rawYaml).toBe('version: 2 # broken');
    expect(row?.parsedJson).toBeNull();
    expect(row?.valid).toBe(false);
    expect(row?.validationErrors).toEqual(['unexpected key']);

    const rows = await t.db.select().from(commitConfigs);
    expect(rows).toHaveLength(1);
  });

  it('upsert refreshes syncedAt to the DB clock on a re-snapshot', async () => {
    const commitId = await seedCommit();

    await commitConfigRepo.upsert({
      commitId,
      rawYaml: 'version: 1',
      parsedJson: { version: 1 },
      valid: true,
      validationErrors: [],
    });
    const first = await commitConfigRepo.findByCommitId(commitId);
    if (first === undefined) {
      throw new Error('expected row after first upsert');
    }

    await commitConfigRepo.upsert({
      commitId,
      rawYaml: 'version: 2',
      parsedJson: { version: 2 },
      valid: true,
      validationErrors: [],
    });
    const second = await commitConfigRepo.findByCommitId(commitId);
    if (second === undefined) {
      throw new Error('expected row after second upsert');
    }

    expect(second.syncedAt.getTime()).toBeGreaterThanOrEqual(first.syncedAt.getTime());
  });

  it('upsert flips present on a re-snapshot (present:true -> false and back)', async () => {
    const commitId = await seedCommit();

    await commitConfigRepo.upsert({
      commitId,
      present: true,
      rawYaml: 'version: 1',
      parsedJson: { version: 1 },
      valid: true,
      validationErrors: [],
    });
    const afterFirst = await commitConfigRepo.findByCommitId(commitId);
    expect(afterFirst?.present).toBe(true);

    await commitConfigRepo.upsert({
      commitId,
      present: false,
      rawYaml: '',
      parsedJson: null,
      valid: false,
      validationErrors: [],
    });
    const afterSecond = await commitConfigRepo.findByCommitId(commitId);
    expect(afterSecond?.present).toBe(false);

    await commitConfigRepo.upsert({
      commitId,
      present: true,
      rawYaml: 'version: 2',
      parsedJson: { version: 2 },
      valid: true,
      validationErrors: [],
    });
    const afterThird = await commitConfigRepo.findByCommitId(commitId);
    expect(afterThird?.present).toBe(true);
  });

  it('findByCommitId returns undefined when there is no config for the commit', async () => {
    const commitId = await seedCommit();
    expect(await commitConfigRepo.findByCommitId(commitId)).toBeUndefined();
    expect(await commitConfigRepo.findByCommitId(randomUUID())).toBeUndefined();
  });
});
