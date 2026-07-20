import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { commitConfigs, commits, providerConnections, repos, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

function one<T>(rows: T[]): T {
  const [row] = rows;
  if (row === undefined) {
    throw new Error('expected an inserted row');
  }
  return row;
}

function commitValues(repoId: string, overrides: Partial<typeof commits.$inferInsert> = {}) {
  return {
    repoId,
    sha: 'abc123',
    branch: 'main',
    message: 'initial message',
    authorName: 'Author',
    authorEmail: 'author@example.com',
    committedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('commit-config schema constraints (pglite)', () => {
  let t: TestDb;

  beforeEach(async () => {
    t = await createTestDb();
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
    const repoId = one(
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
    ).id;
    return one(await t.db.insert(commits).values(commitValues(repoId)).returning()).id;
  }

  it('rejects a second config for the same commit (1:1 via uniqueIndex on commit_id)', async () => {
    const commitId = await seedCommit();
    await t.db.insert(commitConfigs).values({ commitId, rawYaml: 'a: 1', valid: true });
    await expect(t.db.insert(commitConfigs).values({ commitId, rawYaml: 'a: 2', valid: true })).rejects.toThrow();
  });

  it('cascades the config when its commit is deleted', async () => {
    const commitId = await seedCommit();
    await t.db.insert(commitConfigs).values({ commitId, rawYaml: 'a: 1', valid: true });
    await t.db.delete(commits).where(eq(commits.id, commitId));
    expect(await t.db.select().from(commitConfigs).where(eq(commitConfigs.commitId, commitId))).toHaveLength(0);
  });

  it('defaults present to true when a row is inserted without it', async () => {
    const commitId = await seedCommit();
    await t.db.insert(commitConfigs).values({ commitId, rawYaml: 'a: 1', valid: true });
    const [row] = await t.db.select().from(commitConfigs).where(eq(commitConfigs.commitId, commitId));
    expect(row?.present).toBe(true);
  });

  it('stores an explicit present:false row (the absent marker)', async () => {
    const commitId = await seedCommit();
    await t.db.insert(commitConfigs).values({ commitId, present: false, rawYaml: '', valid: false });
    const [row] = await t.db.select().from(commitConfigs).where(eq(commitConfigs.commitId, commitId));
    expect(row?.present).toBe(false);
  });
});
