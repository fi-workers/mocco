import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CredentialGrantNotFoundError } from '@backend/domain/credential/errors';
import { GrantService } from '@backend/domain/credential/GrantService';
import { CredentialGrantRepo } from '@backend/domain/credential/repos/credential-grant.repo';
import { expectOne } from '@backend/infra/db/rows';
import { providerConnections, repos, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type { CredentialGrantCreateInput } from '@mocco/common/credential';

/** Grant create-input with sensible defaults; overridable per field. Module-scoped
 * (captures nothing) so it needn't be rebuilt per test. */
const grantInput = (repoId: string, over: Partial<CredentialGrantCreateInput> = {}): CredentialGrantCreateInput => ({
  repoId,
  pipeline: 'deploy',
  gateName: 'prod-approval',
  provider: 'aws',
  role: 'deploy-role',
  maxTtlSeconds: 3600,
  ...over,
});

describe('GrantService (pglite)', () => {
  let t: TestDb;
  let service: GrantService;
  let repo: CredentialGrantRepo;

  beforeEach(async () => {
    t = await createTestDb();
    repo = new CredentialGrantRepo(t.db);
    service = new GrantService({ grants: repo });
  });
  afterEach(async () => {
    await t.close();
  });

  async function seedWorkspace(name = 'W'): Promise<string> {
    return expectOne(await t.db.insert(workspaces).values({ name, slug: randomUUID() }).returning()).id;
  }

  /** A repo under the workspace (via a provider connection), returning its id. */
  async function seedRepo(workspaceId: string): Promise<string> {
    const conn = expectOne(
      await t.db
        .insert(providerConnections)
        .values({ workspaceId, provider: 'github', externalAccountId: randomUUID(), accountLogin: 'acme' })
        .returning(),
    );
    return expectOne(
      await t.db
        .insert(repos)
        .values({
          workspaceId,
          connectionId: conn.id,
          externalRepoId: randomUUID(),
          owner: 'fi-workers',
          name: 'api',
          defaultBranch: 'main',
        })
        .returning(),
    ).id;
  }

  describe('create / list / delete', () => {
    it('creates a grant and lists it, scoped to the workspace', async () => {
      const workspaceId = await seedWorkspace();
      const repoId = await seedRepo(workspaceId);
      const created = await service.create(workspaceId, grantInput(repoId));
      expect(created).toMatchObject({ workspaceId, repoId, provider: 'aws', role: 'deploy-role', maxTtlSeconds: 3600 });

      // A grant in another workspace must never leak into this list.
      const otherWorkspaceId = await seedWorkspace('other');
      const otherRepoId = await seedRepo(otherWorkspaceId);
      await service.create(otherWorkspaceId, grantInput(otherRepoId));

      const grants = await service.list(workspaceId);
      expect(grants).toHaveLength(1);
      expect(grants[0]?.id).toBe(created.id);
    });

    it('deletes a grant', async () => {
      const workspaceId = await seedWorkspace();
      const repoId = await seedRepo(workspaceId);
      const grant = await service.create(workspaceId, grantInput(repoId));

      await service.delete(workspaceId, grant.id);
      expect(await service.list(workspaceId)).toHaveLength(0);
    });

    it('throws CredentialGrantNotFoundError deleting an unknown grant', async () => {
      const workspaceId = await seedWorkspace();
      await expect(service.delete(workspaceId, randomUUID())).rejects.toBeInstanceOf(CredentialGrantNotFoundError);
    });

    it('throws CredentialGrantNotFoundError deleting a grant in another workspace (tenant isolation)', async () => {
      const workspaceId = await seedWorkspace();
      const repoId = await seedRepo(workspaceId);
      const grant = await service.create(workspaceId, grantInput(repoId));
      const otherWorkspaceId = await seedWorkspace('other');

      await expect(service.delete(otherWorkspaceId, grant.id)).rejects.toBeInstanceOf(CredentialGrantNotFoundError);
    });
  });

  describe('findMatching (repo lookup the broker uses)', () => {
    it('finds the grant matching the exact allowlist tuple', async () => {
      const workspaceId = await seedWorkspace();
      const repoId = await seedRepo(workspaceId);
      const created = await service.create(workspaceId, grantInput(repoId));

      const found = await repo.findMatching(workspaceId, {
        repoId,
        pipeline: 'deploy',
        gateName: 'prod-approval',
        provider: 'aws',
        role: 'deploy-role',
      });
      expect(found?.id).toBe(created.id);
    });

    it('returns undefined when any tuple field differs (fail-closed)', async () => {
      const workspaceId = await seedWorkspace();
      const repoId = await seedRepo(workspaceId);
      await service.create(workspaceId, grantInput(repoId));

      const found = await repo.findMatching(workspaceId, {
        repoId,
        pipeline: 'deploy',
        gateName: 'prod-approval',
        provider: 'aws',
        role: 'a-different-role',
      });
      expect(found).toBeUndefined();
    });

    it('never matches a grant in another workspace (tenant isolation)', async () => {
      const workspaceId = await seedWorkspace();
      const repoId = await seedRepo(workspaceId);
      await service.create(workspaceId, grantInput(repoId));
      const otherWorkspaceId = await seedWorkspace('other');

      const found = await repo.findMatching(otherWorkspaceId, {
        repoId,
        pipeline: 'deploy',
        gateName: 'prod-approval',
        provider: 'aws',
        role: 'deploy-role',
      });
      expect(found).toBeUndefined();
    });
  });
});
