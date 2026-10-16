import { and, eq, sql } from 'drizzle-orm';

import * as schema from '@backend/infra/db/schema';

import type { FeedbackScope } from '@backend/domain/feedback/scope';
import type { Db } from '@backend/infra/db/types';

const r = schema.feedbackChangelogReads;

/** Data access for mocco_feedback_changelog_reads: an end user's read cursor per board. */
export class ChangelogReadRepo {
  constructor(private readonly db: Db) {}

  async lastSeenAt(scope: FeedbackScope, boardId: string, endUserId: string): Promise<Date | null> {
    const [row] = await this.db
      .select({ lastSeenAt: r.lastSeenAt })
      .from(r)
      .where(
        and(
          eq(r.workspaceId, scope.workspaceId),
          eq(r.projectId, scope.projectId),
          eq(r.boardId, boardId),
          eq(r.endUserId, endUserId),
        ),
      );
    return row?.lastSeenAt ?? null;
  }

  /** Move the cursor to `at`, never back; returns where it is. */
  async markSeen(scope: FeedbackScope, boardId: string, endUserId: string, at: Date): Promise<Date> {
    const [row] = await this.db
      .insert(r)
      .values({ ...scope, boardId, endUserId, lastSeenAt: at })
      .onConflictDoUpdate({
        target: [r.boardId, r.endUserId],
        set: { lastSeenAt: sql`greatest(${r.lastSeenAt}, excluded.last_seen_at)` },
      })
      .returning({ lastSeenAt: r.lastSeenAt });
    return row?.lastSeenAt ?? at;
  }
}
