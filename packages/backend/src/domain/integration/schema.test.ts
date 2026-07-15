import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { providerConnections, repos, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

function one<T>(rows: T[]): T {
  const [row] = rows;
  if (row === undefined) {
    throw new Error('expected an inserted row');
  }
  return row;
}

describe('integration schema constraints (pglite)', () => {
  let t: TestDb;

  beforeEach(async () => {
    t = await createTestDb();
  });

  afterEach(async () => {
    await t.close();
  });

  async function seedWorkspace(name = 'W'): Promise<string> {
    return one(await t.db.insert(workspaces).values({ name, slug: randomUUID() }).returning()).id;
  }

  async function seedConnection(workspaceId: string) {
    return one(
      await t.db
        .insert(providerConnections)
        .values({ workspaceId, provider: 'github', externalAccountId: randomUUID(), accountLogin: 'acme' })
        .returning(),
    );
  }

  it('rejects a duplicate (connection_id, external_repo_id)', async () => {
    const workspaceId = await seedWorkspace();
    const conn = await seedConnection(workspaceId);
    const vals = {
      workspaceId,
      connectionId: conn.id,
      externalRepoId: '123',
      owner: 'o',
      name: 'n',
      defaultBranch: 'main',
    };
    await t.db.insert(repos).values(vals);
    await expect(t.db.insert(repos).values(vals)).rejects.toThrow();
  });

  it('rejects a duplicate (provider, external_account_id)', async () => {
    const workspaceId = await seedWorkspace();
    const conn = await seedConnection(workspaceId);
    const otherWorkspace = await seedWorkspace('Other');
    await expect(
      t.db.insert(providerConnections).values({
        workspaceId: otherWorkspace,
        provider: 'github',
        externalAccountId: conn.externalAccountId,
        accountLogin: 'x',
      }),
    ).rejects.toThrow();
  });

  it('cascades repos when the connection is deleted', async () => {
    const workspaceId = await seedWorkspace();
    const conn = await seedConnection(workspaceId);
    await t.db.insert(repos).values({
      workspaceId,
      connectionId: conn.id,
      externalRepoId: '1',
      owner: 'o',
      name: 'n',
      defaultBranch: 'main',
    });
    await t.db.delete(providerConnections).where(eq(providerConnections.id, conn.id));
    expect(await t.db.select().from(repos)).toHaveLength(0);
  });

  it('rejects a provider outside the allowed set (CHECK)', async () => {
    const workspaceId = await seedWorkspace();
    await expect(
      t.db
        .insert(providerConnections)
        // raw SQL bypasses the compile-time Provider type to exercise the DB CHECK
        .values({ workspaceId, provider: sql`'gitlab'`, externalAccountId: randomUUID(), accountLogin: 'x' }),
    ).rejects.toThrow();
  });

  it('rejects a repo whose workspace_id does not match its connection (composite FK)', async () => {
    const workspaceId = await seedWorkspace();
    const conn = await seedConnection(workspaceId);
    const otherWorkspace = await seedWorkspace('Other');
    await expect(
      t.db.insert(repos).values({
        workspaceId: otherWorkspace,
        connectionId: conn.id,
        externalRepoId: '9',
        owner: 'o',
        name: 'n',
        defaultBranch: 'main',
      }),
    ).rejects.toThrow();
  });
});
