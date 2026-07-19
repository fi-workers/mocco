import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ProviderConnectionRepo } from '@backend/domain/integration/repos/provider-connection.repo';
import { workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

describe('ProviderConnectionRepo (pglite)', () => {
  let t: TestDb;
  let providerConnectionRepo: ProviderConnectionRepo;

  beforeEach(async () => {
    t = await createTestDb();
    providerConnectionRepo = new ProviderConnectionRepo(t.db);
  });

  afterEach(async () => {
    await t.close();
  });

  async function seedWorkspace(): Promise<string> {
    const [row] = await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning();
    if (row === undefined) {
      throw new Error('expected a workspace row');
    }
    return row.id;
  }

  it('updateStatusByExternalAccount updates the matching (provider, external_account_id) row only', async () => {
    const workspaceId = await seedWorkspace();
    const target = await providerConnectionRepo.upsert(workspaceId, 'github', {
      externalAccountId: 'acct-target',
      accountLogin: 'target-login',
    });
    const other = await providerConnectionRepo.upsert(workspaceId, 'github', {
      externalAccountId: 'acct-other',
      accountLogin: 'other-login',
    });

    await providerConnectionRepo.updateStatusByExternalAccount('github', 'acct-target', 'suspended');

    const updated = await providerConnectionRepo.findByExternalAccount('github', 'acct-target');
    expect(updated?.status).toBe('suspended');
    expect(updated?.id).toBe(target.id);

    const untouched = await providerConnectionRepo.findByExternalAccount('github', 'acct-other');
    expect(untouched?.status).toBe('active');
    expect(untouched?.id).toBe(other.id);
  });
});
