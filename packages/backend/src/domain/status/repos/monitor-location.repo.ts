import { and, count, eq, inArray, isNull, sql } from 'drizzle-orm';

import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

export type MonitorLocationRow = typeof schema.statusMonitorLocations.$inferSelect;

const ml = schema.statusMonitorLocations;
const loc = schema.statusLocations;

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

  /**
   * The enabled locations the monitor runs at (each owes a result, or is `no_data`), and how many of
   * them a round waits for: the ones not silent (`unhealthy_since` null, #151).
   */
  async countForRound(workspaceId: string, monitorId: string): Promise<{ enabled: number; awaited: number }> {
    const [row] = await this.db
      .select({ enabled: count(), awaited: count(sql`CASE WHEN ${loc.unhealthySince} IS NULL THEN 1 END`) })
      .from(ml)
      .innerJoin(loc, eq(loc.id, ml.locationId))
      .where(and(eq(ml.workspaceId, workspaceId), eq(ml.monitorId, monitorId), isNull(loc.disabledAt)));
    return { enabled: row?.enabled ?? 0, awaited: row?.awaited ?? 0 };
  }

  /** Replace the monitor's locations. Call inside a transaction. */
  async replace(workspaceId: string, monitorId: string, locationIds: readonly string[]): Promise<void> {
    await this.db.delete(ml).where(and(eq(ml.workspaceId, workspaceId), eq(ml.monitorId, monitorId)));
    if (locationIds.length > 0) {
      await this.db.insert(ml).values(locationIds.map(locationId => ({ workspaceId, monitorId, locationId })));
    }
  }
}
