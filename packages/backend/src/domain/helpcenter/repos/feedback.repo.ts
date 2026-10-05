import { and, count, desc, eq, getTableColumns, gte, isNotNull, sql } from 'drizzle-orm';

import { expectOne } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

export type HelpFeedbackRow = typeof schema.helpFeedback.$inferSelect;

const f = schema.helpFeedback;

/** Data access for mocco_help_feedback. Scoped by workspace and project. */
export class HelpFeedbackRepo {
  constructor(private readonly db: Db) {}

  /**
   * Record an answer; a second answer from the same visitor for the same article and day
   * replaces the first. `inserted` is false for a replacement.
   */
  async upsert(row: Omit<typeof f.$inferInsert, 'id' | 'createdAt' | 'updatedAt'>, now: Date) {
    const rows = await this.db
      .insert(f)
      .values({ ...row, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: [f.articleId, f.visitorHash, f.day],
        set: { helpful: row.helpful, locale: row.locale, comment: row.comment ?? null, updatedAt: now },
      })
      // xmax is 0 only for a row this statement inserted.
      .returning({ ...getTableColumns(f), inserted: sql<boolean>`(xmax = 0)` });
    return expectOne(rows);
  }

  /** Answers per value of `helpful` for one article since `sinceDay` (inclusive). */
  async counts(workspaceId: string, projectId: string, articleId: string, sinceDay: string) {
    return await this.db
      .select({ helpful: f.helpful, count: count() })
      .from(f)
      .where(
        and(
          eq(f.workspaceId, workspaceId),
          eq(f.projectId, projectId),
          eq(f.articleId, articleId),
          gte(f.day, sinceDay),
        ),
      )
      .groupBy(f.helpful);
  }

  /** The newest answers with a comment for one article since `sinceDay`. */
  async withComments(workspaceId: string, projectId: string, articleId: string, sinceDay: string, limit: number) {
    return await this.db
      .select()
      .from(f)
      .where(
        and(
          eq(f.workspaceId, workspaceId),
          eq(f.projectId, projectId),
          eq(f.articleId, articleId),
          gte(f.day, sinceDay),
          isNotNull(f.comment),
        ),
      )
      .orderBy(desc(f.updatedAt))
      .limit(limit);
  }
}
