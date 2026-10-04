import { and, asc, eq, sql } from 'drizzle-orm';

import { expectOne } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { StatusScope } from '@backend/domain/status/scope';
import type { Db } from '@backend/infra/db/types';

export type ComponentGroupRow = typeof schema.statusComponentGroups.$inferSelect;

const g = schema.statusComponentGroups;
const scoped = (scope: StatusScope) => and(eq(g.workspaceId, scope.workspaceId), eq(g.projectId, scope.projectId));

/** Data access for mocco_status_component_groups. Scoped by workspace and project. */
export class ComponentGroupRepo {
  constructor(private readonly db: Db) {}

  async listForPage(scope: StatusScope, pageId: string): Promise<ComponentGroupRow[]> {
    return await this.db
      .select()
      .from(g)
      .where(and(scoped(scope), eq(g.pageId, pageId)))
      .orderBy(asc(g.position), asc(g.createdAt));
  }

  async find(scope: StatusScope, id: string): Promise<ComponentGroupRow | undefined> {
    const [row] = await this.db
      .select()
      .from(g)
      .where(and(scoped(scope), eq(g.id, id)));
    return row;
  }

  /** The position after the page's last group. */
  async nextPosition(pageId: string): Promise<number> {
    const [row] = await this.db
      .select({ next: sql<number>`coalesce(max(${g.position}) + 1, 0)::int` })
      .from(g)
      .where(eq(g.pageId, pageId));
    return row?.next ?? 0;
  }

  async insert(row: typeof g.$inferInsert): Promise<ComponentGroupRow> {
    return expectOne(await this.db.insert(g).values(row).returning());
  }

  async update(
    scope: StatusScope,
    id: string,
    values: { name: string; position?: number },
  ): Promise<ComponentGroupRow | undefined> {
    const [row] = await this.db
      .update(g)
      .set({ ...values, updatedAt: new Date() })
      .where(and(scoped(scope), eq(g.id, id)))
      .returning();
    return row;
  }

  /** Ungroup the group's components, then delete it. False when the scope has no such group. */
  async delete(scope: StatusScope, id: string): Promise<boolean> {
    return await this.db.transaction(async tx => {
      const c = schema.statusComponents;
      await tx
        .update(c)
        .set({ groupId: null, updatedAt: new Date() })
        .where(and(eq(c.workspaceId, scope.workspaceId), eq(c.projectId, scope.projectId), eq(c.groupId, id)));
      const rows = await tx
        .delete(g)
        .where(and(scoped(scope), eq(g.id, id)))
        .returning({ id: g.id });
      return rows.length > 0;
    });
  }
}
