import { and, desc, eq } from 'drizzle-orm';

import { expectOne } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

export type MonitorStateChangeRow = typeof schema.statusMonitorStateChanges.$inferSelect;

const sc = schema.statusMonitorStateChanges;

/** Data access for mocco_status_monitor_state_changes (append-only). Scoped by workspace. */
export class MonitorStateChangeRepo {
  constructor(private readonly db: Db) {}

  async append(row: typeof sc.$inferInsert): Promise<MonitorStateChangeRow> {
    return expectOne(await this.db.insert(sc).values(row).returning());
  }

  /** The monitor's latest changes, newest first. */
  async listForMonitor(workspaceId: string, monitorId: string, limit = 50): Promise<MonitorStateChangeRow[]> {
    return await this.db
      .select()
      .from(sc)
      .where(and(eq(sc.workspaceId, workspaceId), eq(sc.monitorId, monitorId)))
      .orderBy(desc(sc.at))
      .limit(limit);
  }
}
