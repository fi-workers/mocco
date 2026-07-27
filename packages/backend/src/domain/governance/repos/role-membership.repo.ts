import { and, asc, eq } from 'drizzle-orm';

import { expectOne } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

/** Data access for mocco_role_memberships — the (role, user) join. Reads are
 * scoped by `workspace_id` (carried on each row); a membership is unique per
 * (role, user) by DB constraint. */
export class RoleMembershipRepo {
  constructor(private readonly db: Db) {}

  /** Add a user to a role. Idempotent on the (role, user) unique index — a repeat
   * add is a no-op that still returns the existing row. */
  async add(row: typeof schema.roleMemberships.$inferInsert) {
    return expectOne(
      await this.db
        .insert(schema.roleMemberships)
        .values(row)
        .onConflictDoUpdate({
          target: [schema.roleMemberships.roleId, schema.roleMemberships.userId],
          // No mutable field to change on conflict — re-set workspaceId to a no-op so
          // the row is returned rather than silently dropped by onConflictDoNothing.
          set: { workspaceId: row.workspaceId },
        })
        .returning(),
    );
  }

  /** Remove a user from a role, scoped by workspace_id. */
  async remove(workspaceId: string, roleId: string, userId: string) {
    await this.db
      .delete(schema.roleMemberships)
      .where(
        and(
          eq(schema.roleMemberships.workspaceId, workspaceId),
          eq(schema.roleMemberships.roleId, roleId),
          eq(schema.roleMemberships.userId, userId),
        ),
      );
  }

  /** The roles a user belongs to within a workspace — each as `{ roleId, name }`
   * (joined with mocco_roles for the name). The gate service intersects these with a
   * gate's required role names to authorize a vote and build the evaluator input. */
  async listRolesForUser(workspaceId: string, userId: string) {
    return await this.db
      .select({ roleId: schema.roleMemberships.roleId, name: schema.roles.name })
      .from(schema.roleMemberships)
      .innerJoin(schema.roles, eq(schema.roleMemberships.roleId, schema.roles.id))
      .where(and(eq(schema.roleMemberships.workspaceId, workspaceId), eq(schema.roleMemberships.userId, userId)));
  }

  /** A role's memberships joined with each member's user (name/email) — the shape
   * the Access page's per-role member list needs. Scoped by workspace_id, name-ordered. */
  async listByRoleWithUser(workspaceId: string, roleId: string) {
    const rows = await this.db
      .select({ membership: schema.roleMemberships, user: schema.users })
      .from(schema.roleMemberships)
      .innerJoin(schema.users, eq(schema.roleMemberships.userId, schema.users.id))
      .where(and(eq(schema.roleMemberships.workspaceId, workspaceId), eq(schema.roleMemberships.roleId, roleId)))
      .orderBy(asc(schema.users.name));
    return rows.map(row => ({ ...row.membership, user: row.user }));
  }
}
