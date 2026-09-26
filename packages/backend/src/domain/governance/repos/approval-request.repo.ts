import { ApprovalKinds, ApprovalStates } from '@mocco/common/governance';
import { and, desc, eq, lte } from 'drizzle-orm';

import { expectOne, getOrThrow } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';
import type { ApprovalKind, ApprovalState } from '@mocco/common/governance';

export interface ApprovalRequestFilter {
  state?: ApprovalState;
  kind?: ApprovalKind;
  subjectType?: string;
  subjectId?: string;
}

/** Data access for mocco_approval_requests. Every read/write is scoped by `workspace_id`. */
export class ApprovalRequestRepo {
  constructor(private readonly db: Db) {}

  async create(row: typeof schema.approvalRequests.$inferInsert) {
    return expectOne(await this.db.insert(schema.approvalRequests).values(row).returning());
  }

  /** A request owned by the workspace — or throw EntityNotFoundError. */
  async getByIdInWorkspace(workspaceId: string, requestId: string) {
    const rows = await this.db
      .select()
      .from(schema.approvalRequests)
      .where(and(eq(schema.approvalRequests.id, requestId), eq(schema.approvalRequests.workspaceId, workspaceId)));
    return getOrThrow(rows, `Approval request ${requestId} was not found`);
  }

  /** The workspace's requests, newest first, optionally filtered. */
  async list(workspaceId: string, filter: ApprovalRequestFilter) {
    return await this.db
      .select()
      .from(schema.approvalRequests)
      .where(
        and(
          eq(schema.approvalRequests.workspaceId, workspaceId),
          filter.state === undefined ? undefined : eq(schema.approvalRequests.state, filter.state),
          filter.kind === undefined ? undefined : eq(schema.approvalRequests.kind, filter.kind),
          filter.subjectType === undefined ? undefined : eq(schema.approvalRequests.subjectType, filter.subjectType),
          filter.subjectId === undefined ? undefined : eq(schema.approvalRequests.subjectId, filter.subjectId),
        ),
      )
      .orderBy(desc(schema.approvalRequests.createdAt));
  }

  /**
   * Move a request out of `pending` — ONLY if it is still pending. Returns the updated
   * row, or undefined when another writer resolved it first. This conditional update
   * is what makes an approval's handler run at most once under concurrent votes.
   */
  async resolveIfPending(workspaceId: string, requestId: string, state: ApprovalState) {
    const [row] = await this.db
      .update(schema.approvalRequests)
      .set({ state, resolvedAt: new Date() })
      .where(
        and(
          eq(schema.approvalRequests.id, requestId),
          eq(schema.approvalRequests.workspaceId, workspaceId),
          eq(schema.approvalRequests.state, ApprovalStates.pending),
        ),
      )
      .returning();
    return row;
  }

  /** Pending pre-approvals for a subject — the ones a newer change supersedes. Reviews
   * are never superseded: they are evidence about a change that was already applied. */
  async listPendingPreApprovalsForSubject(workspaceId: string, subjectType: string, subjectId: string) {
    return await this.list(workspaceId, {
      state: ApprovalStates.pending,
      kind: ApprovalKinds.preApproval,
      subjectType,
      subjectId,
    });
  }

  /** Pending requests whose expiry has passed. */
  async listExpired(workspaceId: string, now: Date) {
    return await this.db
      .select()
      .from(schema.approvalRequests)
      .where(
        and(
          eq(schema.approvalRequests.workspaceId, workspaceId),
          eq(schema.approvalRequests.state, ApprovalStates.pending),
          lte(schema.approvalRequests.expiresAt, now),
        ),
      );
  }
}
