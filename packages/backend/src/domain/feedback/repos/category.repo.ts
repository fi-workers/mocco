import { and, asc, eq, sql } from 'drizzle-orm';

import { rethrowUniqueViolation } from '@backend/infra/db/errors';
import { expectOne } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { FeedbackScope } from '@backend/domain/feedback/scope';
import type { Db } from '@backend/infra/db/types';

export type FeedbackCategoryRow = typeof schema.feedbackCategories.$inferSelect;

const c = schema.feedbackCategories;
const scoped = (scope: FeedbackScope) => and(eq(c.workspaceId, scope.workspaceId), eq(c.projectId, scope.projectId));

/** Data access for mocco_feedback_categories. Scoped by workspace and project. */
export class FeedbackCategoryRepo {
  constructor(private readonly db: Db) {}

  async listForBoard(scope: FeedbackScope, boardId: string): Promise<FeedbackCategoryRow[]> {
    return await this.db
      .select()
      .from(c)
      .where(and(scoped(scope), eq(c.boardId, boardId)))
      .orderBy(asc(c.position), asc(c.createdAt));
  }

  async find(scope: FeedbackScope, id: string): Promise<FeedbackCategoryRow | undefined> {
    const [row] = await this.db
      .select()
      .from(c)
      .where(and(scoped(scope), eq(c.id, id)));
    return row;
  }

  async nextPosition(boardId: string): Promise<number> {
    const [row] = await this.db
      .select({ next: sql<number>`coalesce(max(${c.position}) + 1, 0)::int` })
      .from(c)
      .where(eq(c.boardId, boardId));
    return row?.next ?? 0;
  }

  /** A taken slug throws UniqueConstraintError (`mocco_feedback_categories_board_slug_uq`). */
  async insert(row: typeof c.$inferInsert): Promise<FeedbackCategoryRow> {
    try {
      return expectOne(await this.db.insert(c).values(row).returning());
    } catch (error) {
      return rethrowUniqueViolation(error);
    }
  }

  /** The updated category, or undefined when the scope has no such category. */
  async update(
    scope: FeedbackScope,
    id: string,
    values: { slug: string; name: string; position?: number },
  ): Promise<FeedbackCategoryRow | undefined> {
    try {
      const [row] = await this.db
        .update(c)
        .set({ ...values, updatedAt: new Date() })
        .where(and(scoped(scope), eq(c.id, id)))
        .returning();
      return row;
    } catch (error) {
      return rethrowUniqueViolation(error);
    }
  }

  /** Delete the category; uncategorize its posts first (FeedbackPostRepo.uncategorize), in the
   * same transaction. False when the scope has no such category. */
  async delete(scope: FeedbackScope, id: string): Promise<boolean> {
    const rows = await this.db
      .delete(c)
      .where(and(scoped(scope), eq(c.id, id)))
      .returning({ id: c.id });
    return rows.length > 0;
  }
}
