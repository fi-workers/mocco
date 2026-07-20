import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CommitRepo } from '@backend/domain/integration/repos/commit.repo';
import { EntityNotFoundError } from '@backend/infra/db/errors';
import { providerConnections, repos, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type * as schema from '@backend/infra/db/schema';

function one<T>(rows: T[]): T {
  const [row] = rows;
  if (row === undefined) {
    throw new Error('expected one row');
  }
  return row;
}

function commitValues(repoId: string, overrides: Partial<typeof schema.commits.$inferInsert> = {}) {
  return {
    repoId,
    sha: randomUUID(),
    branch: 'main',
    message: 'initial message',
    authorName: 'Author',
    authorEmail: 'author@example.com',
    committedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('CommitRepo (pglite)', () => {
  let t: TestDb;
  let commitRepo: CommitRepo;

  beforeEach(async () => {
    t = await createTestDb();
    commitRepo = new CommitRepo(t.db);
  });

  afterEach(async () => {
    await t.close();
  });

  async function seedRepo(): Promise<{ workspaceId: string; repoId: string }> {
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
    return { workspaceId, repoId: repoRow.id };
  }

  it('upsertMany is idempotent on (repo_id, sha) — commits are immutable', async () => {
    const { repoId } = await seedRepo();
    const sha = 'sha-fixed';
    await commitRepo.upsertMany([commitValues(repoId, { sha, message: 'first' })]);
    // A redelivery of the same commit must not clobber the original row.
    await commitRepo.upsertMany([commitValues(repoId, { sha, message: 'second (should be ignored)' })]);

    const rows = await commitRepo.listByRepo(repoId, null, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.message).toBe('first');
  });

  it('listByRepo returns newest-first and pages strictly by cursor', async () => {
    const { repoId } = await seedRepo();
    // Insert 5 distinct commits in one call — seq is assigned in insertion order.
    await commitRepo.upsertMany([
      commitValues(repoId, { sha: 'sha-1' }),
      commitValues(repoId, { sha: 'sha-2' }),
      commitValues(repoId, { sha: 'sha-3' }),
      commitValues(repoId, { sha: 'sha-4' }),
      commitValues(repoId, { sha: 'sha-5' }),
    ]);

    const firstPage = await commitRepo.listByRepo(repoId, null, 2);
    expect(firstPage).toHaveLength(3); // limit + 1, so the service can compute nextCursor
    expect(firstPage.map(r => r.sha)).toEqual(['sha-5', 'sha-4', 'sha-3']); // newest-first

    const cursor = firstPage[1]?.seq;
    if (cursor === undefined) {
      throw new Error('expected a cursor row');
    }
    const secondPage = await commitRepo.listByRepo(repoId, cursor, 2);
    expect(secondPage.map(r => r.sha)).toEqual(['sha-3', 'sha-2', 'sha-1']);
    // Every row strictly precedes the cursor.
    expect(secondPage.every(row => row.seq < cursor)).toBe(true);
  });

  it('listByRepo scopes to the given repo only', async () => {
    const { repoId: repoA } = await seedRepo();
    const { repoId: repoB } = await seedRepo();
    await commitRepo.upsertMany([commitValues(repoA, { sha: 'a-1' })]);
    await commitRepo.upsertMany([commitValues(repoB, { sha: 'b-1' })]);

    expect(await commitRepo.listByRepo(repoA, null, 10)).toHaveLength(1);
    expect(await commitRepo.listByRepo(repoB, null, 10)).toHaveLength(1);
  });

  it('getByIdInWorkspace returns the raw row for a commit owned by the workspace', async () => {
    const { workspaceId, repoId } = await seedRepo();
    await commitRepo.upsertMany([commitValues(repoId, { sha: 'sha-owned', message: 'owned' })]);
    const [row] = await commitRepo.listByRepo(repoId, null, 10);
    if (row === undefined) {
      throw new Error('expected a seeded commit row');
    }

    const found = await commitRepo.getByIdInWorkspace(workspaceId, row.id);
    expect(found.id).toBe(row.id);
    expect(found.message).toBe('owned');
  });

  it('getByIdInWorkspace throws EntityNotFoundError for a commit owned by a different workspace', async () => {
    const { repoId } = await seedRepo();
    const { workspaceId: foreignWorkspaceId } = await seedRepo();
    await commitRepo.upsertMany([commitValues(repoId, { sha: 'sha-foreign' })]);
    const [row] = await commitRepo.listByRepo(repoId, null, 10);
    if (row === undefined) {
      throw new Error('expected a seeded commit row');
    }

    await expect(commitRepo.getByIdInWorkspace(foreignWorkspaceId, row.id)).rejects.toBeInstanceOf(EntityNotFoundError);
  });

  it('getByIdInWorkspace throws EntityNotFoundError for an unknown commit id', async () => {
    const { workspaceId } = await seedRepo();
    await expect(commitRepo.getByIdInWorkspace(workspaceId, randomUUID())).rejects.toBeInstanceOf(EntityNotFoundError);
  });
});
