import { and, asc, eq, sql } from 'drizzle-orm';

import { rethrowUniqueViolation } from '@backend/infra/db/errors';
import { expectOne } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { FeedbackScope } from '@backend/domain/feedback/scope';
import type { Db } from '@backend/infra/db/types';

export type FeedbackBoardRow = typeof schema.feedbackBoards.$inferSelect;

const b = schema.feedbackBoards;
const scoped = (scope: FeedbackScope) => and(eq(b.workspaceId, scope.workspaceId), eq(b.projectId, scope.projectId));

/** Data access for mocco_feedback_boards. Scoped by workspace and project. */
export class FeedbackBoardRepo {
  constructor(private readonly db: Db) {}

  async list(scope: FeedbackScope): Promise<FeedbackBoardRow[]> {
    return await this.db.select().from(b).where(scoped(scope)).orderBy(asc(b.createdAt), asc(b.id));
  }

  async find(scope: FeedbackScope, id: string): Promise<FeedbackBoardRow | undefined> {
    const [row] = await this.db
      .select()
      .from(b)
      .where(and(scoped(scope), eq(b.id, id)));
    return row;
  }

  async findBySlug(scope: FeedbackScope, slug: string): Promise<FeedbackBoardRow | undefined> {
    const [row] = await this.db
      .select()
      .from(b)
      .where(and(scoped(scope), eq(b.slug, slug)));
    return row;
  }

  /** A taken slug throws UniqueConstraintError (`mocco_feedback_boards_project_slug_uq`). */
  async insert(row: typeof b.$inferInsert): Promise<FeedbackBoardRow> {
    try {
      return expectOne(await this.db.insert(b).values(row).returning());
    } catch (error) {
      return rethrowUniqueViolation(error);
    }
  }

  /** The updated board, or undefined when the scope has no such board. */
  async update(
    scope: FeedbackScope,
    id: string,
    values: { slug: string; name: string; isPublic?: boolean },
  ): Promise<FeedbackBoardRow | undefined> {
    try {
      const [row] = await this.db
        .update(b)
        .set({ ...values, updatedAt: new Date() })
        .where(and(scoped(scope), eq(b.id, id)))
        .returning();
      return row;
    } catch (error) {
      return rethrowUniqueViolation(error);
    }
  }

  /**
   * Take the board's next post number, or undefined when the scope has no such board. The
   * update locks the board row, so concurrent posts on one board get distinct numbers; run it
   * in the post insert's transaction so a failed insert gives the number back.
   */
  async takePostNumber(scope: FeedbackScope, id: string): Promise<number | undefined> {
    const [row] = await this.db
      .update(b)
      .set({ nextPostNumber: sql`${b.nextPostNumber} + 1` })
      .where(and(scoped(scope), eq(b.id, id)))
      .returning({ taken: sql<number>`${b.nextPostNumber} - 1` });
    return row?.taken;
  }

  /** Delete the board and, by cascade, its categories, posts and their history. False when the
   * scope has no such board. */
  async delete(scope: FeedbackScope, id: string): Promise<boolean> {
    const rows = await this.db
      .delete(b)
      .where(and(scoped(scope), eq(b.id, id)))
      .returning({ id: b.id });
    return rows.length > 0;
  }
}
