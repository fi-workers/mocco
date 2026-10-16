import { ChangelogEntryStates } from '@mocco/common/feedback';
import { and, asc, desc, eq, inArray, like, lte, or, sql } from 'drizzle-orm';

import { rethrowUniqueViolation } from '@backend/infra/db/errors';
import { expectOne } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { FeedbackScope } from '@backend/domain/feedback/scope';
import type { Db } from '@backend/infra/db/types';
import type { ChangelogEntryState } from '@mocco/common/feedback';

export type ChangelogEntryRow = typeof schema.changelogEntries.$inferSelect;

const e = schema.changelogEntries;
const ep = schema.changelogEntryPosts;
const scoped = (scope: FeedbackScope) => and(eq(e.workspaceId, scope.workspaceId), eq(e.projectId, scope.projectId));

/** Data access for mocco_changelog_entries and their posts. Scoped by workspace and project,
 * except the publish job's scan for due entries. */
export class ChangelogEntryRepo {
  constructor(private readonly db: Db) {}

  /** A board's entries in one state or all: the newest published, scheduled or edited first. */
  async list(
    scope: FeedbackScope,
    query: { boardId: string; state?: ChangelogEntryState; limit: number; offset: number },
  ): Promise<ChangelogEntryRow[]> {
    return await this.db
      .select()
      .from(e)
      .where(
        and(
          scoped(scope),
          eq(e.boardId, query.boardId),
          query.state === undefined ? undefined : eq(e.state, query.state),
        ),
      )
      .orderBy(desc(sql`coalesce(${e.publishedAt}, ${e.publishAt}, ${e.updatedAt})`), desc(e.id))
      .limit(query.limit)
      .offset(query.offset);
  }

  async find(scope: FeedbackScope, id: string): Promise<ChangelogEntryRow | undefined> {
    const [row] = await this.db
      .select()
      .from(e)
      .where(and(scoped(scope), eq(e.id, id)));
    return row;
  }

  /** The entry, locked until the transaction ends. */
  async findForUpdate(scope: FeedbackScope, id: string): Promise<ChangelogEntryRow | undefined> {
    const [row] = await this.db
      .select()
      .from(e)
      .where(and(scoped(scope), eq(e.id, id)))
      .for('update');
    return row;
  }

  /** The board's slugs that are `base` or `base-<n>`, to pick a free one. */
  async slugsLike(boardId: string, base: string): Promise<string[]> {
    const rows = await this.db
      .select({ slug: e.slug })
      .from(e)
      .where(and(eq(e.boardId, boardId), or(eq(e.slug, base), like(e.slug, `${base}-%`))));
    return rows.map(row => row.slug);
  }

  /** A taken slug throws UniqueConstraintError (`mocco_changelog_entries_board_slug_uq`). */
  async insert(row: typeof e.$inferInsert): Promise<ChangelogEntryRow> {
    try {
      return expectOne(await this.db.insert(e).values(row).returning());
    } catch (error) {
      return rethrowUniqueViolation(error);
    }
  }

  /** The updated entry, or undefined when the scope has no such entry. A taken slug throws
   * UniqueConstraintError. */
  async update(
    scope: FeedbackScope,
    id: string,
    values: Partial<
      Pick<ChangelogEntryRow, 'slug' | 'title' | 'bodyMd' | 'tags' | 'state' | 'publishAt' | 'publishedAt'>
    >,
  ): Promise<ChangelogEntryRow | undefined> {
    try {
      const [row] = await this.db
        .update(e)
        .set({ ...values, updatedAt: new Date() })
        .where(and(scoped(scope), eq(e.id, id)))
        .returning();
      return row;
    } catch (error) {
      return rethrowUniqueViolation(error);
    }
  }

  async delete(scope: FeedbackScope, id: string): Promise<boolean> {
    const rows = await this.db
      .delete(e)
      .where(and(scoped(scope), eq(e.id, id)))
      .returning({ id: e.id });
    return rows.length > 0;
  }

  /** Scheduled entries whose time has come, oldest first, locked and skipped by a concurrent scan. */
  async lockDue(now: Date, limit: number): Promise<ChangelogEntryRow[]> {
    return await this.db
      .select()
      .from(e)
      .where(and(eq(e.state, ChangelogEntryStates.scheduled), lte(e.publishAt, now)))
      .orderBy(asc(e.publishAt))
      .limit(limit)
      .for('update', { skipLocked: true });
  }

  /** The posts each entry announces, in the entry's order. */
  async postIdsOf(entryIds: readonly string[]): Promise<Map<string, string[]>> {
    const rows =
      entryIds.length === 0
        ? []
        : await this.db
            .select({ entryId: ep.entryId, postId: ep.postId })
            .from(ep)
            .where(inArray(ep.entryId, [...entryIds]))
            .orderBy(asc(ep.entryId), asc(ep.position));
    return new Map(entryIds.map(id => [id, rows.filter(row => row.entryId === id).map(row => row.postId)]));
  }

  /** Make the entry announce exactly these posts, in this order. */
  async replacePosts(workspaceId: string, entryId: string, postIds: readonly string[]): Promise<void> {
    await this.db.delete(ep).where(eq(ep.entryId, entryId));
    if (postIds.length > 0) {
      await this.db.insert(ep).values(postIds.map((postId, position) => ({ entryId, postId, workspaceId, position })));
    }
  }
}
