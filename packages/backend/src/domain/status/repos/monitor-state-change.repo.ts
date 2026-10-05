import { and, desc, eq, gte, lt } from 'drizzle-orm';

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

  /**
   * Every monitor's changes in `[from, to)`, plus each monitor's last change before `from`, so the
   * state each window opens with is known. System-wide, for the rollup job.
   */
  async listForWindow(from: Date, to: Date): Promise<MonitorStateChangeRow[]> {
    const [inWindow, before] = await Promise.all([
      this.db
        .select()
        .from(sc)
        .where(and(gte(sc.at, from), lt(sc.at, to))),
      this.db.selectDistinctOn([sc.monitorId]).from(sc).where(lt(sc.at, from)).orderBy(sc.monitorId, desc(sc.at)),
    ]);
    return [...before, ...inWindow];
  }
}
