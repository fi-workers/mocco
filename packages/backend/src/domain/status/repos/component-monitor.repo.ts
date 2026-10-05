import { and, asc, eq, inArray } from 'drizzle-orm';

import * as schema from '@backend/infra/db/schema';

import type { StatusScope } from '@backend/domain/status/scope';
import type { Db } from '@backend/infra/db/types';
import type { MonitorComponent } from '@mocco/common/status';

export type ComponentMonitorRow = typeof schema.statusComponentMonitors.$inferSelect;

const cm = schema.statusComponentMonitors;
const c = schema.statusComponents;
const m = schema.statusMonitors;

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

  /** Every workspace's links. System-wide, for the rollup job. */
  async listAll(): Promise<ComponentMonitorRow[]> {
    return await this.db.select().from(cm);
  }

  /** The current state of every monitor linked to a page's components, one row per link. */
  async monitorStatesForPage(scope: StatusScope, pageId: string) {
    return await this.db
      .select({ componentId: cm.componentId, impactWhenDown: cm.impactWhenDown, state: m.state })
      .from(cm)
      .innerJoin(c, and(eq(c.id, cm.componentId), eq(c.workspaceId, cm.workspaceId)))
      .innerJoin(m, and(eq(m.id, cm.monitorId), eq(m.workspaceId, cm.workspaceId)))
      .where(and(eq(c.workspaceId, scope.workspaceId), eq(c.projectId, scope.projectId), eq(c.pageId, pageId)));
  }

  /** The components the monitor reports on, with their pages, in page order. */
  async componentsOfMonitor(workspaceId: string, monitorId: string) {
    return await this.db
      .select({ componentId: cm.componentId, impactWhenDown: cm.impactWhenDown, pageId: c.pageId })
      .from(cm)
      .innerJoin(c, and(eq(c.id, cm.componentId), eq(c.workspaceId, cm.workspaceId)))
      .where(and(eq(cm.workspaceId, workspaceId), eq(cm.monitorId, monitorId)))
      .orderBy(asc(c.pageId), asc(c.position), asc(c.createdAt));
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
