import { and, asc, eq } from 'drizzle-orm';

import { expectOne } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

/** Data access for mocco_approval_votes. Every read is scoped by `workspace_id`; one
 * vote per (request, user) by DB constraint. */
export class ApprovalVoteRepo {
  constructor(private readonly db: Db) {}

  async insert(row: typeof schema.approvalVotes.$inferInsert) {
    return expectOne(await this.db.insert(schema.approvalVotes).values(row).returning());
  }

  /** The request's votes, oldest first. */
  async listByRequest(workspaceId: string, requestId: string) {
    return await this.db
      .select()
      .from(schema.approvalVotes)
      .where(and(eq(schema.approvalVotes.workspaceId, workspaceId), eq(schema.approvalVotes.requestId, requestId)))
      .orderBy(asc(schema.approvalVotes.createdAt));
  }

  /** The user's vote on the request, if any. */
  async findByRequestAndUser(workspaceId: string, requestId: string, userId: string) {
    const [row] = await this.db
      .select()
      .from(schema.approvalVotes)
      .where(
        and(
          eq(schema.approvalVotes.workspaceId, workspaceId),
          eq(schema.approvalVotes.requestId, requestId),
          eq(schema.approvalVotes.userId, userId),
        ),
      );
    return row;
  }
}
