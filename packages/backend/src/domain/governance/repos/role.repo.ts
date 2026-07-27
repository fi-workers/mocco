import { and, asc, eq } from 'drizzle-orm';

import { expectOne, getOrThrow } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

/** Data access for mocco_roles. Every read/write is scoped by `workspace_id` —
 * roles carry it directly, so a role is never resolved by id alone. */
export class RoleRepo {
  constructor(private readonly db: Db) {}

  /** Insert a role and return the created row. */
  async create(row: typeof schema.roles.$inferInsert) {
    return expectOne(await this.db.insert(schema.roles).values(row).returning());
  }

  /** A workspace's roles, name-ordered. */
  async listByWorkspace(workspaceId: string) {
    return await this.db
      .select()
      .from(schema.roles)
      .where(eq(schema.roles.workspaceId, workspaceId))
      .orderBy(asc(schema.roles.name));
  }

  /** A role owned by the workspace, keyed by its own id — or throw EntityNotFoundError
   * for a foreign or unknown id. Direct workspace_id scoping (roles carry it). */
  async getByIdInWorkspace(workspaceId: string, roleId: string) {
    const rows = await this.db
      .select()
      .from(schema.roles)
      .where(and(eq(schema.roles.id, roleId), eq(schema.roles.workspaceId, workspaceId)));
    return getOrThrow(rows, `Role ${roleId} was not found`);
  }

  /** Delete a role owned by the workspace (its memberships cascade). Scoped by workspace_id. */
  async delete(workspaceId: string, roleId: string) {
    await this.db
      .delete(schema.roles)
      .where(and(eq(schema.roles.id, roleId), eq(schema.roles.workspaceId, workspaceId)));
  }
}
