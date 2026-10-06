import { FEEDBACK_POST_STATUS_ORDER, FeedbackPostSorts } from '@mocco/common/feedback';
import { and, asc, desc, eq, sql } from 'drizzle-orm';

import { expectOne } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { FeedbackScope } from '@backend/domain/feedback/scope';
import type { Db } from '@backend/infra/db/types';
import type { FeedbackPostListQuery, FeedbackPostStatus } from '@mocco/common/feedback';

export type FeedbackPostRow = typeof schema.feedbackPosts.$inferSelect;

const p = schema.feedbackPosts;
const scoped = (scope: FeedbackScope) => and(eq(p.workspaceId, scope.workspaceId), eq(p.projectId, scope.projectId));

/** A status's place in the workflow (FEEDBACK_POST_STATUS_ORDER), for sorting by status. */
const statusRank = sql`array_position(ARRAY[${sql.join(
  FEEDBACK_POST_STATUS_ORDER.map(status => sql`${status}`),
  sql`, `,
)}]::text[], ${p.status})`;

/** Data access for mocco_feedback_posts. Scoped by workspace and project. */
export class FeedbackPostRepo {
  constructor(private readonly db: Db) {}

  async insert(row: typeof p.$inferInsert): Promise<FeedbackPostRow> {
    return expectOne(await this.db.insert(p).values(row).returning());
  }

  async find(scope: FeedbackScope, id: string): Promise<FeedbackPostRow | undefined> {
    const [row] = await this.db
      .select()
      .from(p)
      .where(and(scoped(scope), eq(p.id, id)));
    return row;
  }

  /** The post, locked until the transaction ends, so concurrent status changes apply one at a time. */
  async findForUpdate(scope: FeedbackScope, id: string): Promise<FeedbackPostRow | undefined> {
    const [row] = await this.db
      .select()
      .from(p)
      .where(and(scoped(scope), eq(p.id, id)))
      .for('update');
    return row;
  }

  /** A board's posts, filtered, sorted and paged as the query says. */
  async list(scope: FeedbackScope, query: FeedbackPostListQuery): Promise<FeedbackPostRow[]> {
    const order =
      query.sort === FeedbackPostSorts.status
        ? [asc(statusRank), desc(p.createdAt), desc(p.number)]
        : [desc(p.createdAt), desc(p.number)];
    return await this.db
      .select()
      .from(p)
      .where(
        and(
          scoped(scope),
          eq(p.boardId, query.boardId),
          query.status === undefined ? undefined : eq(p.status, query.status),
          query.categoryId === undefined ? undefined : eq(p.categoryId, query.categoryId),
        ),
      )
      .orderBy(...order)
      .limit(query.limit)
      .offset(query.offset);
  }

  /** The updated post, or undefined when the scope has no such post. */
  async update(
    scope: FeedbackScope,
    id: string,
    values: Partial<{ title: string; body: string; categoryId: string | null }>,
  ): Promise<FeedbackPostRow | undefined> {
    const [row] = await this.db
      .update(p)
      .set({ ...values, updatedAt: new Date() })
      .where(and(scoped(scope), eq(p.id, id)))
      .returning();
    return row;
  }

  /** Set the status; `shippedAt` is set entering shipped and null otherwise (DB-checked). */
  async setStatus(
    scope: FeedbackScope,
    id: string,
    values: { status: FeedbackPostStatus; shippedAt: Date | null },
  ): Promise<FeedbackPostRow> {
    return expectOne(
      await this.db
        .update(p)
        .set({ ...values, updatedAt: new Date() })
        .where(and(scoped(scope), eq(p.id, id)))
        .returning(),
    );
  }

  /** Add `delta` (negative to take away) to the post's vote or comment count, in the
   * transaction that wrote the vote or comment, so the count never drifts from the rows. */
  async addToCount(
    scope: FeedbackScope,
    id: string,
    counter: 'voteCount' | 'commentCount',
    delta: number,
  ): Promise<FeedbackPostRow> {
    return expectOne(
      await this.db
        .update(p)
        .set({ [counter]: sql`${p[counter]} + ${delta}` })
        .where(and(scoped(scope), eq(p.id, id)))
        .returning(),
    );
  }

  /** Uncategorize the category's posts, before the category is deleted. */
  async uncategorize(scope: FeedbackScope, categoryId: string): Promise<void> {
    await this.db
      .update(p)
      .set({ categoryId: null, updatedAt: new Date() })
      .where(and(scoped(scope), eq(p.categoryId, categoryId)));
  }
}
