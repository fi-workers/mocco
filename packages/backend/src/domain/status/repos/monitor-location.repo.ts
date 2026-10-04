import { and, eq, inArray } from 'drizzle-orm';

import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

export type MonitorLocationRow = typeof schema.statusMonitorLocations.$inferSelect;

const ml = schema.statusMonitorLocations;

/** Data access for mocco_status_monitor_locations. Scoped by workspace. */
export class MonitorLocationRepo {
  constructor(private readonly db: Db) {}

  async listFor(workspaceId: string, monitorIds: readonly string[]): Promise<MonitorLocationRow[]> {
    if (monitorIds.length === 0) {
      return [];
    }
    return await this.db
      .select()
      .from(ml)
      .where(and(eq(ml.workspaceId, workspaceId), inArray(ml.monitorId, [...monitorIds])));
  }

  /** Replace the monitor's locations. Call inside a transaction. */
  async replace(workspaceId: string, monitorId: string, locationIds: readonly string[]): Promise<void> {
    await this.db.delete(ml).where(and(eq(ml.workspaceId, workspaceId), eq(ml.monitorId, monitorId)));
    if (locationIds.length > 0) {
      await this.db.insert(ml).values(locationIds.map(locationId => ({ workspaceId, monitorId, locationId })));
    }
  }
}
