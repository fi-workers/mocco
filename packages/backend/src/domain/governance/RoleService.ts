import { RoleNotFoundError } from '@backend/domain/governance/errors';
import { EntityNotFoundError } from '@backend/infra/db/errors';

import type { RoleMembershipRepo } from '@backend/domain/governance/repos/role-membership.repo';
import type { RoleRepo } from '@backend/domain/governance/repos/role.repo';

export interface RoleServiceDeps {
  roles: RoleRepo;
  memberships: RoleMembershipRepo;
}

/**
 * Owns access policy: a workspace's named roles and their memberships — the
 * authorization surface gates will resume against (a gate requires N members of a
 * role). Anemic domain (ADR 0012) — reaches the DB only through repos, maps their
 * `EntityNotFoundError` to a domain error, and narrows to the wire shape via
 * `.output` at the router. Every operation is workspace-scoped.
 */
export class RoleService {
  constructor(private readonly deps: RoleServiceDeps) {}

  /** A role owned by the workspace, or throw RoleNotFoundError. A role is NEVER
   * resolved by id alone — always through the workspace-scoped repo. */
  private async requireRole(workspaceId: string, roleId: string) {
    try {
      return await this.deps.roles.getByIdInWorkspace(workspaceId, roleId);
    } catch (error) {
      if (error instanceof EntityNotFoundError) {
        throw new RoleNotFoundError(roleId, { cause: error });
      }
      throw error;
    }
  }

  /** Create a role in the workspace. */
  async create(workspaceId: string, name: string) {
    return await this.deps.roles.create({ workspaceId, name });
  }

  /** The workspace's roles, name-ordered. */
  async list(workspaceId: string) {
    return await this.deps.roles.listByWorkspace(workspaceId);
  }

  /** Delete a role owned by the workspace (its memberships cascade). Throws
   * RoleNotFoundError for a foreign or unknown role. */
  async delete(workspaceId: string, roleId: string): Promise<void> {
    await this.requireRole(workspaceId, roleId);
    await this.deps.roles.delete(workspaceId, roleId);
  }

  /** Add a user to a role owned by the workspace. Throws RoleNotFoundError for a
   * foreign or unknown role; idempotent on a repeat add (one membership per person). */
  async addMember(workspaceId: string, roleId: string, userId: string) {
    await this.requireRole(workspaceId, roleId);
    return await this.deps.memberships.add({ workspaceId, roleId, userId });
  }

  /** Remove a user from a role owned by the workspace. Throws RoleNotFoundError for
   * a foreign or unknown role. */
  async removeMember(workspaceId: string, roleId: string, userId: string): Promise<void> {
    await this.requireRole(workspaceId, roleId);
    await this.deps.memberships.remove(workspaceId, roleId, userId);
  }

  /** The members of a role owned by the workspace, each with the joined user. */
  async listMembers(workspaceId: string, roleId: string) {
    await this.requireRole(workspaceId, roleId);
    return await this.deps.memberships.listByRoleWithUser(workspaceId, roleId);
  }
}
