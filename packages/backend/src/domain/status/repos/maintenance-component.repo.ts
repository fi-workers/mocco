import { MaintenanceStatuses } from '@mocco/common/status';
import { and, eq, inArray } from 'drizzle-orm';

import * as schema from '@backend/infra/db/schema';

import type { StatusScope } from '@backend/domain/status/scope';
import type { Db } from '@backend/infra/db/types';

export type MaintenanceComponentRow = typeof schema.statusMaintenanceComponents.$inferSelect;

const mc = schema.statusMaintenanceComponents;
const m = schema.statusMaintenances;

/** Data access for mocco_status_maintenance_components. Scoped by workspace. */
export class MaintenanceComponentRepo {
  constructor(private readonly db: Db) {}

  /** The components of each of `maintenanceIds`. */
  async listFor(workspaceId: string, maintenanceIds: readonly string[]): Promise<MaintenanceComponentRow[]> {
    if (maintenanceIds.length === 0) {
      return [];
    }
    return await this.db
      .select()
      .from(mc)
      .where(and(eq(mc.workspaceId, workspaceId), inArray(mc.maintenanceId, [...maintenanceIds])));
  }

  async insertMany(workspaceId: string, maintenanceId: string, componentIds: readonly string[]): Promise<void> {
    const unique = [...new Set(componentIds)];
    if (unique.length > 0) {
      await this.db.insert(mc).values(unique.map(componentId => ({ workspaceId, maintenanceId, componentId })));
    }
  }

  /** Whether a window in progress covers any of `componentIds`. */
  async isAnyInProgress(workspaceId: string, componentIds: readonly string[]): Promise<boolean> {
    if (componentIds.length === 0) {
      return false;
    }
    const rows = await this.db
      .select({ componentId: mc.componentId })
      .from(mc)
      .innerJoin(m, and(eq(m.id, mc.maintenanceId), eq(m.workspaceId, mc.workspaceId)))
      .where(
        and(
          eq(mc.workspaceId, workspaceId),
          inArray(mc.componentId, [...componentIds]),
          eq(m.status, MaintenanceStatuses.inProgress),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /** The page's components under a window in progress. */
  async inProgressComponentIds(scope: StatusScope, pageId: string): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ componentId: mc.componentId })
      .from(mc)
      .innerJoin(m, and(eq(m.id, mc.maintenanceId), eq(m.workspaceId, mc.workspaceId)))
      .where(
        and(
          eq(m.workspaceId, scope.workspaceId),
          eq(m.projectId, scope.projectId),
          eq(m.pageId, pageId),
          eq(m.status, MaintenanceStatuses.inProgress),
        ),
      );
    return rows.map(row => row.componentId);
  }
}
