import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RoleNotFoundError } from '@backend/domain/governance/errors';
import { RoleMembershipRepo } from '@backend/domain/governance/repos/role-membership.repo';
import { RoleRepo } from '@backend/domain/governance/repos/role.repo';
import { RoleService } from '@backend/domain/governance/RoleService';
import { expectOne } from '@backend/infra/db/rows';
import { users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

describe('RoleService (pglite)', () => {
  let t: TestDb;
  let service: RoleService;

  beforeEach(async () => {
    t = await createTestDb();
    service = new RoleService({
      roles: new RoleRepo(t.db),
      memberships: new RoleMembershipRepo(t.db),
    });
  });
  afterEach(async () => {
    await t.close();
  });

  async function seedWorkspace(name = 'W'): Promise<string> {
    return expectOne(await t.db.insert(workspaces).values({ name, slug: randomUUID() }).returning()).id;
  }

  async function seedUser(name: string | null = 'Ada'): Promise<string> {
    return expectOne(
      await t.db
        .insert(users)
        .values({ email: `${randomUUID()}@example.com`, name })
        .returning(),
    ).id;
  }

  describe('roles', () => {
    it('creates and lists roles name-ordered, scoped to the workspace', async () => {
      const workspaceId = await seedWorkspace();
      await service.create(workspaceId, 'sre');
      await service.create(workspaceId, 'deployer');
      // A role in another workspace must never leak into this list.
      await service.create(await seedWorkspace('other'), 'deployer');

      const roles = await service.list(workspaceId);
      expect(roles.map(role => role.name)).toEqual(['deployer', 'sre']);
      expect(roles.every(role => role.workspaceId === workspaceId)).toBe(true);
    });

    it('deletes a role', async () => {
      const workspaceId = await seedWorkspace();
      const role = await service.create(workspaceId, 'deployer');

      await service.delete(workspaceId, role.id);
      expect(await service.list(workspaceId)).toHaveLength(0);
    });

    it('throws RoleNotFoundError deleting an unknown role', async () => {
      const workspaceId = await seedWorkspace();
      await expect(service.delete(workspaceId, randomUUID())).rejects.toBeInstanceOf(RoleNotFoundError);
    });

    it('throws RoleNotFoundError deleting a role in another workspace (tenant isolation)', async () => {
      const workspaceId = await seedWorkspace();
      const role = await service.create(workspaceId, 'deployer');
      const otherWorkspaceId = await seedWorkspace('other');

      await expect(service.delete(otherWorkspaceId, role.id)).rejects.toBeInstanceOf(RoleNotFoundError);
    });
  });

  describe('memberships', () => {
    it('adds a member and lists it with the joined user', async () => {
      const workspaceId = await seedWorkspace();
      const role = await service.create(workspaceId, 'deployer');
      const userId = await seedUser('Ada');

      await service.addMember(workspaceId, role.id, userId);

      const members = await service.listMembers(workspaceId, role.id);
      expect(members).toHaveLength(1);
      expect(members[0]).toMatchObject({ roleId: role.id, userId });
      expect(members[0]?.user).toMatchObject({ id: userId, name: 'Ada' });
    });

    it('is idempotent — adding the same user twice keeps one membership', async () => {
      const workspaceId = await seedWorkspace();
      const role = await service.create(workspaceId, 'deployer');
      const userId = await seedUser();

      await service.addMember(workspaceId, role.id, userId);
      await service.addMember(workspaceId, role.id, userId);

      expect(await service.listMembers(workspaceId, role.id)).toHaveLength(1);
    });

    it('removes a member', async () => {
      const workspaceId = await seedWorkspace();
      const role = await service.create(workspaceId, 'deployer');
      const userId = await seedUser();
      await service.addMember(workspaceId, role.id, userId);

      await service.removeMember(workspaceId, role.id, userId);
      expect(await service.listMembers(workspaceId, role.id)).toHaveLength(0);
    });

    it('deleting a role cascades its memberships', async () => {
      const workspaceId = await seedWorkspace();
      const role = await service.create(workspaceId, 'deployer');
      const userId = await seedUser();
      await service.addMember(workspaceId, role.id, userId);

      await service.delete(workspaceId, role.id);
      // The role is gone; a fresh role with the same name has no members.
      const fresh = await service.create(workspaceId, 'deployer');
      expect(await service.listMembers(workspaceId, fresh.id)).toHaveLength(0);
    });

    it('throws RoleNotFoundError adding a member to a foreign role (tenant isolation)', async () => {
      const workspaceId = await seedWorkspace();
      const role = await service.create(workspaceId, 'deployer');
      const otherWorkspaceId = await seedWorkspace('other');
      const userId = await seedUser();

      await expect(service.addMember(otherWorkspaceId, role.id, userId)).rejects.toBeInstanceOf(RoleNotFoundError);
    });

    it('throws RoleNotFoundError listing members of a foreign role', async () => {
      const workspaceId = await seedWorkspace();
      const role = await service.create(workspaceId, 'deployer');
      const otherWorkspaceId = await seedWorkspace('other');

      await expect(service.listMembers(otherWorkspaceId, role.id)).rejects.toBeInstanceOf(RoleNotFoundError);
    });
  });
});
