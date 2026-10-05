import { MaintenanceStatuses } from '@mocco/common/status';
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';

import { expectOne } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { StatusScope } from '@backend/domain/status/scope';
import type { Db } from '@backend/infra/db/types';
import type { MaintenanceStatus } from '@mocco/common/status';

export type MaintenanceRow = typeof schema.statusMaintenances.$inferSelect;

const m = schema.statusMaintenances;
const scoped = (scope: StatusScope) => and(eq(m.workspaceId, scope.workspaceId), eq(m.projectId, scope.projectId));

/** Data access for mocco_status_maintenances. Scoped by workspace and project, except the
 * tick's system-wide transitions (`completeDue`, `startDue`, `flagOverrunDue`,
 * `listRunLinkedInProgress`) and the run's own (`completeForRun`), which go by workspace. */
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

  /** The page's windows in progress or still to come, soonest first. */
  async listUpcoming(scope: StatusScope, pageId: string): Promise<MaintenanceRow[]> {
    return await this.db
      .select()
      .from(m)
      .where(
        and(
          scoped(scope),
          eq(m.pageId, pageId),
          inArray(m.status, [MaintenanceStatuses.scheduled, MaintenanceStatuses.inProgress]),
        ),
      )
      .orderBy(asc(m.scheduledStart))
      .limit(50);
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

  /** Insert a window a resumed gate started; undefined when the gate already started one on the page. */
  async insertForGate(row: typeof m.$inferInsert): Promise<MaintenanceRow | undefined> {
    const [created] = await this.db
      .insert(m)
      .values(row)
      .onConflictDoNothing({ target: [m.gateId, m.pageId], where: isNotNull(m.gateId) })
      .returning();
    return created;
  }

  /** Complete the run's windows still in progress, with `endNote` saying why when not as planned. */
  async completeForRun(
    workspaceId: string,
    runId: string,
    values: { now: Date; endNote: string | null },
  ): Promise<MaintenanceRow[]> {
    return await this.db
      .update(m)
      .set({
        status: MaintenanceStatuses.completed,
        actualEnd: values.now,
        endNote: values.endNote,
        updatedAt: values.now,
      })
      .where(and(eq(m.workspaceId, workspaceId), eq(m.runId, runId), eq(m.status, MaintenanceStatuses.inProgress)))
      .returning();
  }

  /** Every run-linked window in progress, across all workspaces (the tick checks their runs). */
  async listRunLinkedInProgress(): Promise<MaintenanceRow[]> {
    return await this.db
      .select()
      .from(m)
      .where(and(eq(m.status, MaintenanceStatuses.inProgress), isNotNull(m.runId)));
  }

  /** Flag every run-linked window still in progress past its expected end, once. Across all workspaces. */
  async flagOverrunDue(now: Date): Promise<MaintenanceRow[]> {
    return await this.db
      .update(m)
      .set({ overranAt: now, updatedAt: now })
      .where(
        and(
          eq(m.status, MaintenanceStatuses.inProgress),
          isNotNull(m.runId),
          isNull(m.overranAt),
          lte(m.scheduledEnd, now),
        ),
      )
      .returning();
  }

  /** Complete every window whose end has passed (a window the tick never saw start goes
   * straight to completed). A run-linked window ends with its run instead, so it is left
   * alone here. Across all workspaces: the tick is a system job. */
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
          isNull(m.runId),
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
