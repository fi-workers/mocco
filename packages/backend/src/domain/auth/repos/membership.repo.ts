// Data access for mocco_members, keyed by the person rather than by a session.
//
// The vendor's own `listOrganizations` answers from request headers, which is right for
// the console and wrong for MCP: there the caller is identified by a verified access
// token, and there are no session cookies to hand over. This reads the same table the
// organization plugin owns, by user id. (`mocco_members_user_id_idx` exists for it.)
import { and, eq } from 'drizzle-orm';

import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

export class MembershipRepo {
  constructor(private readonly db: Db) {}

  /** The workspaces this person belongs to, with the role they hold in each. */
  async listForUser(userId: string) {
    return await this.db
      .select({
        workspaceId: schema.members.organizationId,
        role: schema.members.role,
        name: schema.workspaces.name,
      })
      .from(schema.members)
      .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.members.organizationId))
      .where(eq(schema.members.userId, userId))
      .orderBy(schema.workspaces.name);
  }

  /** Whether this person belongs to the workspace — the check every tool makes before
   * it reads anything, so a workspace id in a tool call grants nothing on its own. */
  async isMember(userId: string, workspaceId: string) {
    const rows = await this.db
      .select({ id: schema.members.id })
      .from(schema.members)
      .where(and(eq(schema.members.userId, userId), eq(schema.members.organizationId, workspaceId)));
    return rows.length > 0;
  }
}
