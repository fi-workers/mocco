import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RepoRepo } from '@backend/domain/integration/repos/repo.repo';
import { EntityNotFoundError } from '@backend/infra/db/errors';
import { providerConnections, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

function one<T>(rows: T[]): T {
  const [row] = rows;
  if (row === undefined) {
    throw new Error('expected one row');
  }
  return row;
}

describe('RepoRepo (pglite)', () => {
  let t: TestDb;
  let repoRepo: RepoRepo;

  beforeEach(async () => {
    t = await createTestDb();
    repoRepo = new RepoRepo(t.db);
  });

  afterEach(async () => {
    await t.close();
  });

  async function seedConnection(): Promise<{ connectionId: string; workspaceId: string }> {
    const workspaceId = one(await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning()).id;
    const connectionId = one(
      await t.db
        .insert(providerConnections)
        .values({ workspaceId, provider: 'github', externalAccountId: randomUUID(), accountLogin: 'acme' })
        .returning(),
    ).id;
    return { connectionId, workspaceId };
  }

  it('getByConnectionAndExternalRepoId returns the raw row for a matching pair', async () => {
    const { connectionId, workspaceId } = await seedConnection();
    const created = await repoRepo.upsert({
      workspaceId,
      connectionId,
      externalRepoId: '111',
      owner: 'fi-workers',
      name: 'api',
      defaultBranch: 'main',
    });

    const found = await repoRepo.getByConnectionAndExternalRepoId(connectionId, '111');
    expect(found.id).toBe(created.id);
    expect(found.owner).toBe('fi-workers');
  });

  it('getByConnectionAndExternalRepoId throws EntityNotFoundError for a foreign pair', async () => {
    const connectionA = await seedConnection();
    const connectionB = await seedConnection();
    await repoRepo.upsert({
      workspaceId: connectionA.workspaceId,
      connectionId: connectionA.connectionId,
      externalRepoId: '111',
      owner: 'fi-workers',
      name: 'api',
      defaultBranch: 'main',
    });

    // The repo exists, but under connectionA — asking via connectionB must miss.
    await expect(repoRepo.getByConnectionAndExternalRepoId(connectionB.connectionId, '111')).rejects.toBeInstanceOf(
      EntityNotFoundError,
    );
  });

  it('inactivateByConnection sets status=inactive for every repo under the connection, leaves others untouched', async () => {
    const connectionA = await seedConnection();
    const connectionB = await seedConnection();
    const repoA1 = await repoRepo.upsert({
      workspaceId: connectionA.workspaceId,
      connectionId: connectionA.connectionId,
      externalRepoId: '111',
      owner: 'o',
      name: 'a1',
      defaultBranch: 'main',
    });
    const repoA2 = await repoRepo.upsert({
      workspaceId: connectionA.workspaceId,
      connectionId: connectionA.connectionId,
      externalRepoId: '222',
      owner: 'o',
      name: 'a2',
      defaultBranch: 'main',
    });
    const repoB1 = await repoRepo.upsert({
      workspaceId: connectionB.workspaceId,
      connectionId: connectionB.connectionId,
      externalRepoId: '333',
      owner: 'o',
      name: 'b1',
      defaultBranch: 'main',
    });

    await repoRepo.inactivateByConnection(connectionA.connectionId);

    const found = async (connectionId: string, externalRepoId: string) => {
      const row = await repoRepo.getByConnectionAndExternalRepoId(connectionId, externalRepoId);
      return row.status;
    };
    expect(await found(connectionA.connectionId, repoA1.externalRepoId)).toBe('inactive');
    expect(await found(connectionA.connectionId, repoA2.externalRepoId)).toBe('inactive');
    expect(await found(connectionB.connectionId, repoB1.externalRepoId)).toBe('active');
  });

  it('touchLastSynced sets last_synced_at on the repo', async () => {
    const { connectionId, workspaceId } = await seedConnection();
    const created = await repoRepo.upsert({
      workspaceId,
      connectionId,
      externalRepoId: '111',
      owner: 'o',
      name: 'n',
      defaultBranch: 'main',
    });
    expect(created.lastSyncedAt).toBeNull();

    await repoRepo.touchLastSynced(created.id);

    const found = await repoRepo.getByConnectionAndExternalRepoId(connectionId, '111');
    expect(found.lastSyncedAt).not.toBeNull();
  });
});
