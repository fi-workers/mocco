import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm';

import { expectOne } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { StatusScope } from '@backend/domain/status/scope';
import type { Db } from '@backend/infra/db/types';

export type ComponentRow = typeof schema.statusComponents.$inferSelect;

const c = schema.statusComponents;
const scoped = (scope: StatusScope) => and(eq(c.workspaceId, scope.workspaceId), eq(c.projectId, scope.projectId));

/** Data access for mocco_status_components. Scoped by workspace and project. */
export class ComponentRepo {
  constructor(private readonly db: Db) {}

  async listForPage(scope: StatusScope, pageId: string): Promise<ComponentRow[]> {
    return await this.db
      .select()
      .from(c)
      .where(and(scoped(scope), eq(c.pageId, pageId)))
      .orderBy(asc(c.position), asc(c.createdAt));
  }

  /** Every workspace's components created before `at`. System-wide, for the rollup job. */
  async listCreatedBefore(at: Date): Promise<ComponentRow[]> {
    return await this.db.select().from(c).where(lt(c.createdAt, at));
  }

  async find(scope: StatusScope, id: string): Promise<ComponentRow | undefined> {
    const [row] = await this.db
      .select()
      .from(c)
      .where(and(scoped(scope), eq(c.id, id)));
    return row;
  }

  /** The ids among `ids` that are components of the page. */
  async idsOnPage(scope: StatusScope, pageId: string, ids: readonly string[]): Promise<string[]> {
    if (ids.length === 0) {
      return [];
    }
    const rows = await this.db
      .select({ id: c.id })
      .from(c)
      .where(and(scoped(scope), eq(c.pageId, pageId), inArray(c.id, [...ids])));
    return rows.map(row => row.id);
  }

  /** The ids among `ids` that are components of the project, on any of its pages. */
  async idsInProject(scope: StatusScope, ids: readonly string[]): Promise<string[]> {
    if (ids.length === 0) {
      return [];
    }
    const rows = await this.db
      .select({ id: c.id })
      .from(c)
      .where(and(scoped(scope), inArray(c.id, [...ids])));
    return rows.map(row => row.id);
  }

  /** The position after the page's last component. */
  async nextPosition(pageId: string): Promise<number> {
    const [row] = await this.db
      .select({ next: sql<number>`coalesce(max(${c.position}) + 1, 0)::int` })
      .from(c)
      .where(eq(c.pageId, pageId));
    return row?.next ?? 0;
  }

  async insert(row: typeof c.$inferInsert): Promise<ComponentRow> {
    return expectOne(await this.db.insert(c).values(row).returning());
  }

  async update(
    scope: StatusScope,
    id: string,
    values: Partial<Pick<ComponentRow, 'name' | 'description' | 'groupId' | 'position' | 'status'>>,
  ): Promise<ComponentRow | undefined> {
    const [row] = await this.db
      .update(c)
      .set({ ...values, updatedAt: new Date() })
      .where(and(scoped(scope), eq(c.id, id)))
      .returning();
    return row;
  }

  async delete(scope: StatusScope, id: string): Promise<boolean> {
    const rows = await this.db
      .delete(c)
      .where(and(scoped(scope), eq(c.id, id)))
      .returning({ id: c.id });
    return rows.length > 0;
  }
}
