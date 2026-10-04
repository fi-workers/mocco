import { and, asc, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';

import { rethrowUniqueViolation } from '@backend/infra/db/errors';
import { expectOne } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { StatusScope } from '@backend/domain/status/scope';
import type { Db } from '@backend/infra/db/types';

export type StatusPageRow = typeof schema.statusPages.$inferSelect;

const p = schema.statusPages;
const scoped = (scope: StatusScope) => and(eq(p.workspaceId, scope.workspaceId), eq(p.projectId, scope.projectId));

/** Data access for mocco_status_pages. Scoped by workspace and project. */
export class StatusPageRepo {
  constructor(private readonly db: Db) {}

  async list(scope: StatusScope): Promise<StatusPageRow[]> {
    return await this.db.select().from(p).where(scoped(scope)).orderBy(asc(p.createdAt));
  }

  async find(scope: StatusScope, id: string): Promise<StatusPageRow | undefined> {
    const [row] = await this.db
      .select()
      .from(p)
      .where(and(scoped(scope), eq(p.id, id)));
    return row;
  }

  /** A taken slug throws UniqueConstraintError (`mocco_status_pages_slug_uq`). */
  async insert(row: typeof p.$inferInsert): Promise<StatusPageRow> {
    try {
      return expectOne(await this.db.insert(p).values(row).returning());
    } catch (error) {
      return rethrowUniqueViolation(error);
    }
  }

  /** The updated page, or undefined when the scope has no such page. */
  async update(
    scope: StatusScope,
    id: string,
    values: { slug: string; title: string },
  ): Promise<StatusPageRow | undefined> {
    try {
      const [row] = await this.db
        .update(p)
        .set({ ...values, updatedAt: new Date() })
        .where(and(scoped(scope), eq(p.id, id)))
        .returning();
      return row;
    } catch (error) {
      return rethrowUniqueViolation(error);
    }
  }

  /** A page by id alone, for the publish job (which has no caller scope). */
  async findById(id: string): Promise<StatusPageRow | undefined> {
    const [row] = await this.db.select().from(p).where(eq(p.id, id));
    return row;
  }

  /** Mark the pages changed, so the publish job builds a new version. Run it in the change's transaction. */
  async markDirty(ids: readonly string[], now: Date): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    await this.db
      .update(p)
      .set({ dirtyAt: now })
      .where(inArray(p.id, [...ids]));
  }

  /** Clear the mark if nothing changed after `seen` (the value read before the build); a later
   * change keeps the page dirty. Compared at millisecond precision: `seen` came back through a JS
   * Date, which drops the microseconds Postgres keeps when the mark is set in SQL. */
  async clearDirty(id: string, seen: Date): Promise<void> {
    await this.db
      .update(p)
      .set({ dirtyAt: null })
      .where(and(eq(p.id, id), sql`date_trunc('milliseconds', ${p.dirtyAt}) <= ${seen.toISOString()}::timestamp`));
  }

  /** Record that `version` is live, unless a newer one already is. */
  async markPublished(id: string, version: number, at: Date): Promise<void> {
    await this.db
      .update(p)
      .set({ publishedVersion: version, publishedAt: at })
      .where(and(eq(p.id, id), or(isNull(p.publishedVersion), lt(p.publishedVersion, version))));
  }

  /** Pages the publish job has work for, across all workspaces: changed, never published, or
   * whose newest version didn't upload. */
  async needingPublish(limit: number): Promise<Pick<StatusPageRow, 'id' | 'workspaceId'>[]> {
    const s = schema.statusPageSnapshots;
    return await this.db
      .select({ id: p.id, workspaceId: p.workspaceId })
      .from(p)
      .where(
        or(
          isNotNull(p.dirtyAt),
          isNull(p.publishedVersion),
          lt(p.publishedVersion, sql`(select max(${s.version}) from ${s} where ${s.pageId} = ${p.id})`),
        ),
      )
      .orderBy(asc(p.dirtyAt))
      .limit(limit);
  }

  /** Delete the page and, by cascade, everything on it. False when the scope has no such page. */
  async delete(scope: StatusScope, id: string): Promise<boolean> {
    const rows = await this.db
      .delete(p)
      .where(and(scoped(scope), eq(p.id, id)))
      .returning({ id: p.id });
    return rows.length > 0;
  }
}
