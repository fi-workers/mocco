import { FEEDBACK_POST_STATUS_ORDER, FeedbackPostSorts } from '@mocco/common/feedback';
import { FeedbackPublicSorts } from '@mocco/common/feedback-v1';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

import { AdvisoryLockNamespaces } from '@backend/infra/db/advisory-locks';
import { expectOne } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { FeedbackScope } from '@backend/domain/feedback/scope';
import type { Db } from '@backend/infra/db/types';
import type { FeedbackPostListQuery, FeedbackPostStatus } from '@mocco/common/feedback';
import type { FeedbackPublicSort } from '@mocco/common/feedback-v1';

export type FeedbackPostRow = typeof schema.feedbackPosts.$inferSelect;

const p = schema.feedbackPosts;
const byText = (left: string, right: string) => (left < right ? -1 : 1);
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

  /** A board's posts as the public lists them: never a merged duplicate; most voted or newest first. */
  async listPublic(
    scope: FeedbackScope,
    query: {
      boardId: string;
      statuses?: readonly FeedbackPostStatus[];
      categoryId?: string;
      sort: FeedbackPublicSort;
      limit: number;
      offset: number;
    },
  ): Promise<FeedbackPostRow[]> {
    const order =
      query.sort === FeedbackPublicSorts.top
        ? [desc(p.voteCount), desc(p.createdAt), desc(p.number)]
        : [desc(p.createdAt), desc(p.number)];
    return await this.db
      .select()
      .from(p)
      .where(
        and(
          scoped(scope),
          eq(p.boardId, query.boardId),
          isNull(p.mergedIntoPostId),
          query.statuses === undefined ? undefined : inArray(p.status, [...query.statuses]),
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

  /**
   * Lock two posts for a merge until the transaction ends: the `feedbackPost` advisory lock and
   * the row lock of each, both taken in id order so two merges sharing a post never deadlock.
   * Returns the posts found in the scope, keyed by id.
   */
  async lockForMerge(scope: FeedbackScope, ids: [string, string]): Promise<Map<string, FeedbackPostRow>> {
    const ordered = ids.toSorted(byText);
    await ordered.reduce(async (previous, id) => {
      await previous;
      await this.db.execute(sql`SELECT pg_advisory_xact_lock(${AdvisoryLockNamespaces.feedbackPost}, hashtext(${id}))`);
    }, Promise.resolve());
    const rows = await this.db
      .select()
      .from(p)
      .where(and(scoped(scope), inArray(p.id, ordered)))
      .orderBy(asc(p.id))
      .for('update');
    return new Map(rows.map(row => [row.id, row]));
  }

  /** Mark the post merged into `intoPostId`, with the status it ends in. */
  async markMerged(
    scope: FeedbackScope,
    id: string,
    values: { intoPostId: string; at: Date; status: FeedbackPostStatus },
  ): Promise<FeedbackPostRow> {
    return expectOne(
      await this.db
        .update(p)
        .set({
          mergedIntoPostId: values.intoPostId,
          mergedAt: values.at,
          status: values.status,
          shippedAt: null,
          updatedAt: values.at,
        })
        .where(and(scoped(scope), eq(p.id, id)))
        .returning(),
    );
  }

  /** Point the posts merged into `fromPostId` at `toPostId`, so no merge chain forms. */
  async reparentMerged(scope: FeedbackScope, fromPostId: string, toPostId: string): Promise<void> {
    await this.db
      .update(p)
      .set({ mergedIntoPostId: toPostId })
      .where(and(scoped(scope), eq(p.mergedIntoPostId, fromPostId)));
  }

  /** Set the post's vote count to `n` (after a merge moved votes in, recounted from the rows). */
  async setVoteCount(scope: FeedbackScope, id: string, n: number): Promise<FeedbackPostRow> {
    return expectOne(
      await this.db
        .update(p)
        .set({ voteCount: n, updatedAt: new Date() })
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
