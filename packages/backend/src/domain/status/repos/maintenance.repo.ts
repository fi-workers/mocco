import { MaintenanceStatuses } from '@mocco/common/status';
import { and, desc, eq, gt, inArray, lte, sql } from 'drizzle-orm';

import { expectOne } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { StatusScope } from '@backend/domain/status/scope';
import type { Db } from '@backend/infra/db/types';
import type { MaintenanceStatus } from '@mocco/common/status';

export type MaintenanceRow = typeof schema.statusMaintenances.$inferSelect;

const m = schema.statusMaintenances;
const scoped = (scope: StatusScope) => and(eq(m.workspaceId, scope.workspaceId), eq(m.projectId, scope.projectId));

/** Data access for mocco_status_maintenances. Scoped by workspace and project, except the
 * tick's system-wide transitions (`completeDue`, `startDue`). */
export class MaintenanceRepo {
  constructor(private readonly db: Db) {}

  async listForPage(scope: StatusScope, pageId: string): Promise<MaintenanceRow[]> {
    return await this.db
      .select()
      .from(m)
      .where(and(scoped(scope), eq(m.pageId, pageId)))
      .orderBy(desc(m.scheduledStart))
      .limit(200);
  }

  async find(scope: StatusScope, id: string): Promise<MaintenanceRow | undefined> {
    const [row] = await this.db
      .select()
      .from(m)
      .where(and(scoped(scope), eq(m.id, id)));
    return row;
  }

  /** Like find, but locks the row until the transaction ends, so a cancel can't race the tick. */
  async findForUpdate(scope: StatusScope, id: string): Promise<MaintenanceRow | undefined> {
    const [row] = await this.db
      .select()
      .from(m)
      .where(and(scoped(scope), eq(m.id, id)))
      .for('update');
    return row;
  }

  async insert(row: typeof m.$inferInsert): Promise<MaintenanceRow> {
    return expectOne(await this.db.insert(m).values(row).returning());
  }

  async update(
    scope: StatusScope,
    id: string,
    values: { status: MaintenanceStatus; actualEnd?: Date },
  ): Promise<MaintenanceRow> {
    return expectOne(
      await this.db
        .update(m)
        .set({ ...values, updatedAt: new Date() })
        .where(and(scoped(scope), eq(m.id, id)))
        .returning(),
    );
  }

  /** Complete every window whose end has passed (a window the tick never saw start goes
   * straight to completed). Across all workspaces: the tick is a system job. */
  async completeDue(now: Date): Promise<MaintenanceRow[]> {
    return await this.db
      .update(m)
      .set({
        status: MaintenanceStatuses.completed,
        actualStart: sql`coalesce(${m.actualStart}, ${now.toISOString()}::timestamp)`,
        actualEnd: now,
        updatedAt: now,
      })
      .where(
        and(
          inArray(m.status, [MaintenanceStatuses.scheduled, MaintenanceStatuses.inProgress]),
          lte(m.scheduledEnd, now),
        ),
      )
      .returning();
  }

  /** Start every scheduled window whose start has passed and end hasn't. Across all workspaces. */
  async startDue(now: Date): Promise<MaintenanceRow[]> {
    return await this.db
      .update(m)
      .set({ status: MaintenanceStatuses.inProgress, actualStart: now, updatedAt: now })
      .where(and(eq(m.status, MaintenanceStatuses.scheduled), lte(m.scheduledStart, now), gt(m.scheduledEnd, now)))
      .returning();
  }
}
