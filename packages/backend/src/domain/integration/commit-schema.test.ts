import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { commits, providerConnections, repos, webhookDeliveries, workspaces } from '@backend/infra/db/schema';
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

describe('commit + webhook-delivery schema constraints (pglite)', () => {
  let t: TestDb;

  beforeEach(async () => {
    t = await createTestDb();
  });

  afterEach(async () => {
    await t.close();
  });

  async function seedRepo(): Promise<string> {
    const workspaceId = one(await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning()).id;
    const conn = one(
      await t.db
        .insert(providerConnections)
        .values({ workspaceId, provider: 'github', externalAccountId: randomUUID(), accountLogin: 'acme' })
        .returning(),
    );
    return one(
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
  }

  it('upserts a duplicate (repo_id, sha) to a single row', async () => {
    const repoId = await seedRepo();
    await t.db.insert(commits).values(commitValues(repoId));
    await t.db
      .insert(commits)
      .values(commitValues(repoId, { message: 'amended message' }))
      .onConflictDoUpdate({
        target: [commits.repoId, commits.sha],
        set: { message: 'amended message' },
      });

    const rows = await t.db.select().from(commits).where(eq(commits.repoId, repoId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.message).toBe('amended message');
  });

  it('cascades commits when the repo is deleted', async () => {
    const repoId = await seedRepo();
    await t.db.insert(commits).values(commitValues(repoId));
    await t.db.delete(repos).where(eq(repos.id, repoId));
    expect(await t.db.select().from(commits).where(eq(commits.repoId, repoId))).toHaveLength(0);
  });

  it('assigns a monotonically increasing seq across inserts', async () => {
    const repoId = await seedRepo();
    const first = one(
      await t.db
        .insert(commits)
        .values(commitValues(repoId, { sha: 'sha1' }))
        .returning(),
    );
    const second = one(
      await t.db
        .insert(commits)
        .values(commitValues(repoId, { sha: 'sha2' }))
        .returning(),
    );
    const third = one(
      await t.db
        .insert(commits)
        .values(commitValues(repoId, { sha: 'sha3' }))
        .returning(),
    );

    expect(second.seq > first.seq).toBe(true);
    expect(third.seq > second.seq).toBe(true);
  });

  it('rejects a duplicate delivery_id (webhook_deliveries)', async () => {
    const deliveryId = randomUUID();
    await t.db.insert(webhookDeliveries).values({ provider: 'github', deliveryId, eventType: 'push' });
    await expect(
      t.db.insert(webhookDeliveries).values({ provider: 'github', deliveryId, eventType: 'push' }),
    ).rejects.toThrow();
  });
});
