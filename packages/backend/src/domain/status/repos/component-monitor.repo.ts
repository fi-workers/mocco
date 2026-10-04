import { and, eq, inArray } from 'drizzle-orm';

import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';
import type { MonitorComponent } from '@mocco/common/status';

export type ComponentMonitorRow = typeof schema.statusComponentMonitors.$inferSelect;

const cm = schema.statusComponentMonitors;

/** Data access for mocco_status_component_monitors. Scoped by workspace. */
export class ComponentMonitorRepo {
  constructor(private readonly db: Db) {}

  async listFor(workspaceId: string, monitorIds: readonly string[]): Promise<ComponentMonitorRow[]> {
    if (monitorIds.length === 0) {
      return [];
    }
    return await this.db
      .select()
      .from(cm)
      .where(and(eq(cm.workspaceId, workspaceId), inArray(cm.monitorId, [...monitorIds])));
  }

  /** Replace the components the monitor reports on. Call inside a transaction. */
  async replace(workspaceId: string, monitorId: string, components: readonly MonitorComponent[]): Promise<void> {
    await this.db.delete(cm).where(and(eq(cm.workspaceId, workspaceId), eq(cm.monitorId, monitorId)));
    if (components.length > 0) {
      await this.db.insert(cm).values(
        components.map(component => ({
          workspaceId,
          monitorId,
          componentId: component.componentId,
          impactWhenDown: component.impactWhenDown,
        })),
      );
    }
  }
}
