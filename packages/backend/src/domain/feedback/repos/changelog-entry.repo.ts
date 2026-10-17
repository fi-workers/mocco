import { ChangelogEntryStates } from '@mocco/common/feedback';
import { and, asc, desc, eq, gt, inArray, like, lte, or, sql } from 'drizzle-orm';

import { rethrowUniqueViolation } from '@backend/infra/db/errors';
import { expectOne } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { FeedbackScope } from '@backend/domain/feedback/scope';
import type { Db } from '@backend/infra/db/types';
import type { ChangelogEntryState, FeedbackPostStatus } from '@mocco/common/feedback';

export type ChangelogEntryRow = typeof schema.changelogEntries.$inferSelect;

const e = schema.changelogEntries;
const ep = schema.changelogEntryPosts;
const posts = schema.feedbackPosts;
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

  /** The entry drafted from a release run on the board (#179), if there is one. */
  async findBySourceRun(workspaceId: string, boardId: string, runId: string): Promise<ChangelogEntryRow | undefined> {
    const [row] = await this.db
      .select()
      .from(e)
      .where(and(eq(e.workspaceId, workspaceId), eq(e.boardId, boardId), eq(e.sourceRunId, runId)));
    return row;
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

  /** A board's published entries, newest first. */
  async listPublished(scope: FeedbackScope, boardId: string, page: { limit: number; offset: number }) {
    return await this.db
      .select()
      .from(e)
      .where(and(scoped(scope), eq(e.boardId, boardId), eq(e.state, ChangelogEntryStates.published)))
      .orderBy(desc(e.publishedAt), desc(e.createdAt), desc(e.id))
      .limit(page.limit)
      .offset(page.offset);
  }

  /** The boards' published entries (slug and last change), newest first, for a sitemap. */
  async listPublishedForSitemap(scope: FeedbackScope, boardIds: readonly string[], limit: number) {
    return boardIds.length === 0
      ? []
      : await this.db
          .select({ boardId: e.boardId, slug: e.slug, updatedAt: e.updatedAt })
          .from(e)
          .where(and(scoped(scope), inArray(e.boardId, [...boardIds]), eq(e.state, ChangelogEntryStates.published)))
          .orderBy(desc(e.publishedAt), desc(e.createdAt))
          .limit(limit);
  }

  /** How many of the board's entries were published after `since` (all when null), counting to `cap`. */
  async countPublishedSince(scope: FeedbackScope, boardId: string, since: Date | null, cap: number): Promise<number> {
    const rows = await this.db
      .select({ id: e.id })
      .from(e)
      .where(
        and(
          scoped(scope),
          eq(e.boardId, boardId),
          eq(e.state, ChangelogEntryStates.published),
          since === null ? undefined : gt(e.publishedAt, since),
        ),
      )
      .limit(cap);
    return rows.length;
  }

  /** The board's published entry with this slug (its public address). */
  async findPublishedBySlug(scope: FeedbackScope, boardId: string, slug: string) {
    const [row] = await this.db
      .select()
      .from(e)
      .where(and(scoped(scope), eq(e.boardId, boardId), eq(e.slug, slug), eq(e.state, ChangelogEntryStates.published)));
    return row;
  }

  /** The published entries that announce the post, newest first. */
  async listPublishedForPost(scope: FeedbackScope, postId: string, limit: number) {
    return await this.db
      .select({ slug: e.slug, title: e.title, publishedAt: e.publishedAt })
      .from(ep)
      .innerJoin(e, and(eq(e.id, ep.entryId), eq(e.workspaceId, ep.workspaceId)))
      .where(and(scoped(scope), eq(ep.postId, postId), eq(e.state, ChangelogEntryStates.published)))
      .orderBy(desc(e.publishedAt), desc(e.createdAt))
      .limit(limit);
  }

  /** The posts each entry announces (number, title, status), in the entry's order. */
  async postsOf(
    entryIds: readonly string[],
  ): Promise<Map<string, { id: string; number: number; title: string; status: FeedbackPostStatus }[]>> {
    const rows =
      entryIds.length === 0
        ? []
        : await this.db
            .select({
              entryId: ep.entryId,
              id: posts.id,
              number: posts.number,
              title: posts.title,
              status: posts.status,
            })
            .from(ep)
            .innerJoin(posts, and(eq(posts.id, ep.postId), eq(posts.workspaceId, ep.workspaceId)))
            .where(inArray(ep.entryId, [...entryIds]))
            .orderBy(asc(ep.entryId), asc(ep.position));
    return new Map(
      entryIds.map(id => [
        id,
        rows
          .filter(row => row.entryId === id)
          .map(row => ({ id: row.id, number: row.number, title: row.title, status: row.status })),
      ]),
    );
  }

  /** Make the entry announce exactly these posts, in this order. */
  async replacePosts(workspaceId: string, entryId: string, postIds: readonly string[]): Promise<void> {
    await this.db.delete(ep).where(eq(ep.entryId, entryId));
    if (postIds.length > 0) {
      await this.db.insert(ep).values(postIds.map((postId, position) => ({ entryId, postId, workspaceId, position })));
    }
  }
}
