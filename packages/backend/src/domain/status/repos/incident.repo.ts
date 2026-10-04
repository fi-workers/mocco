import { IncidentStatuses, IncidentVisibilities } from '@mocco/common/status';
import { and, desc, eq, ne } from 'drizzle-orm';

import { expectOne } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { StatusScope } from '@backend/domain/status/scope';
import type { Db } from '@backend/infra/db/types';

export type IncidentRow = typeof schema.statusIncidents.$inferSelect;

const i = schema.statusIncidents;
const scoped = (scope: StatusScope) => and(eq(i.workspaceId, scope.workspaceId), eq(i.projectId, scope.projectId));

/** Data access for mocco_status_incidents. Scoped by workspace and project. */
export class IncidentRepo {
  constructor(private readonly db: Db) {}

  /** A page's incidents, newest first; `isOpenOnly` leaves out resolved ones. */
  async listForPage(scope: StatusScope, pageId: string, isOpenOnly: boolean): Promise<IncidentRow[]> {
    return await this.db
      .select()
      .from(i)
      .where(and(scoped(scope), eq(i.pageId, pageId), isOpenOnly ? ne(i.status, IncidentStatuses.resolved) : undefined))
      .orderBy(desc(i.startedAt))
      .limit(200);
  }

  /** The page's published incidents for the public snapshot: every open one, and the newest
   * `resolvedLimit` resolved ones. Drafts never come back from here. */
  async listPublished(scope: StatusScope, pageId: string, resolvedLimit: number) {
    const published = and(scoped(scope), eq(i.pageId, pageId), eq(i.visibility, IncidentVisibilities.published));
    const [open, resolved] = await Promise.all([
      this.db
        .select()
        .from(i)
        .where(and(published, ne(i.status, IncidentStatuses.resolved)))
        .orderBy(desc(i.startedAt)),
      this.db
        .select()
        .from(i)
        .where(and(published, eq(i.status, IncidentStatuses.resolved)))
        .orderBy(desc(i.resolvedAt))
        .limit(resolvedLimit),
    ]);
    return { open, resolved };
  }

  async find(scope: StatusScope, id: string): Promise<IncidentRow | undefined> {
    const [row] = await this.db
      .select()
      .from(i)
      .where(and(scoped(scope), eq(i.id, id)));
    return row;
  }

  /** Like find, but locks the row until the transaction ends, so two updates can't race a transition. */
  async findForUpdate(scope: StatusScope, id: string): Promise<IncidentRow | undefined> {
    const [row] = await this.db
      .select()
      .from(i)
      .where(and(scoped(scope), eq(i.id, id)))
      .for('update');
    return row;
  }

  async insert(row: typeof i.$inferInsert): Promise<IncidentRow> {
    return expectOne(await this.db.insert(i).values(row).returning());
  }

  async update(
    scope: StatusScope,
    id: string,
    values: Partial<Pick<IncidentRow, 'status' | 'identifiedAt' | 'resolvedAt' | 'postmortemMd'>>,
  ): Promise<IncidentRow> {
    return expectOne(
      await this.db
        .update(i)
        .set({ ...values, updatedAt: new Date() })
        .where(and(scoped(scope), eq(i.id, id)))
        .returning(),
    );
  }
}
