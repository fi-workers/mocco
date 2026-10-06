import { and, asc, eq } from 'drizzle-orm';

import { expectOne } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

export type FeedbackStatusChangeRow = typeof schema.feedbackStatusChanges.$inferSelect;

const sc = schema.feedbackStatusChanges;

/** Data access for mocco_feedback_status_changes (append-only). Scoped by workspace. */
export class FeedbackStatusChangeRepo {
  constructor(private readonly db: Db) {}

  async append(row: typeof sc.$inferInsert): Promise<FeedbackStatusChangeRow> {
    return expectOne(await this.db.insert(sc).values(row).returning());
  }

  /** The post's history, oldest first. */
  async listForPost(workspaceId: string, postId: string): Promise<FeedbackStatusChangeRow[]> {
    return await this.db
      .select()
      .from(sc)
      .where(and(eq(sc.workspaceId, workspaceId), eq(sc.postId, postId)))
      .orderBy(asc(sc.createdAt), asc(sc.id));
  }
}
