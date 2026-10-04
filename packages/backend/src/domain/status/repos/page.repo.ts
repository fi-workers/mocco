import { and, asc, eq } from 'drizzle-orm';

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

  /** Delete the page and, by cascade, everything on it. False when the scope has no such page. */
  async delete(scope: StatusScope, id: string): Promise<boolean> {
    const rows = await this.db
      .delete(p)
      .where(and(scoped(scope), eq(p.id, id)))
      .returning({ id: p.id });
    return rows.length > 0;
  }
}
