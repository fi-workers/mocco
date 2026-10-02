import { ChangesetStates } from '@mocco/common/flags';
import { and, desc, eq, lte, sql } from 'drizzle-orm';

import { expectOne } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';
import type { ChangesetState } from '@mocco/common/flags';

export type FlagChangesetRow = typeof schema.flagChangesets.$inferSelect;

/** Data access for mocco_flag_changesets. Every query is scoped by `workspace_id`, except
 * the expiry sweep, which runs across workspaces like every system job. */
export class FlagChangesetRepo {
  constructor(private readonly db: Db) {}

  async insert(row: typeof schema.flagChangesets.$inferInsert) {
    return expectOne(await this.db.insert(schema.flagChangesets).values(row).returning());
  }

  async find(workspaceId: string, changesetId: string) {
    const [row] = await this.db
      .select()
      .from(schema.flagChangesets)
      .where(and(eq(schema.flagChangesets.workspaceId, workspaceId), eq(schema.flagChangesets.id, changesetId)));
    return row;
  }

  /** The proposer's name (or email) for notification messages; null when unknown. */
  async proposerLabel(workspaceId: string, changesetId: string) {
    const [row] = await this.db
      .select({ name: schema.users.name, email: schema.users.email })
      .from(schema.flagChangesets)
      .innerJoin(schema.users, eq(schema.flagChangesets.proposedByUserId, schema.users.id))
      .where(and(eq(schema.flagChangesets.workspaceId, workspaceId), eq(schema.flagChangesets.id, changesetId)));
    return row === undefined ? null : (row.name ?? row.email);
  }

  /** The environment's changesets, newest first. */
  async listByEnvironment(workspaceId: string, environmentId: string, limit: number) {
    return await this.db
      .select()
      .from(schema.flagChangesets)
      .where(
        and(eq(schema.flagChangesets.workspaceId, workspaceId), eq(schema.flagChangesets.environmentId, environmentId)),
      )
      .orderBy(desc(schema.flagChangesets.createdAt))
      .limit(limit);
  }

  async setApprovalRequest(workspaceId: string, changesetId: string, approvalRequestId: string) {
    await this.db
      .update(schema.flagChangesets)
      .set({ approvalRequestId })
      .where(and(eq(schema.flagChangesets.workspaceId, workspaceId), eq(schema.flagChangesets.id, changesetId)));
  }

  /** Move a pending changeset to `state`, only if it is still pending (the first resolver
   * wins); undefined when it was already resolved. */
  async resolvePending(
    workspaceId: string,
    changesetId: string,
    state: Exclude<ChangesetState, 'pending'>,
    values: { resolvedAt: Date; appliedVersion?: number },
  ) {
    const [row] = await this.db
      .update(schema.flagChangesets)
      .set({ state, resolvedAt: values.resolvedAt, appliedVersion: values.appliedVersion ?? null })
      .where(
        and(
          eq(schema.flagChangesets.workspaceId, workspaceId),
          eq(schema.flagChangesets.id, changesetId),
          eq(schema.flagChangesets.state, ChangesetStates.pending),
        ),
      )
      .returning();
    return row;
  }

  /** Pending changesets past their expiry, across workspaces (the expiry job). */
  async listExpired(now: Date, limit: number) {
    return await this.db
      .select()
      .from(schema.flagChangesets)
      .where(
        and(
          sql`${schema.flagChangesets.state} = ${ChangesetStates.pending}`,
          lte(schema.flagChangesets.expiresAt, now),
        ),
      )
      .limit(limit);
  }
}
