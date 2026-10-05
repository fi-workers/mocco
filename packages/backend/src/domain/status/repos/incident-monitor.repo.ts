import { and, eq, isNull } from 'drizzle-orm';

import { expectOne } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { IncidentRow } from '@backend/domain/status/repos/incident.repo';
import type { Db } from '@backend/infra/db/types';

export type IncidentMonitorRow = typeof schema.statusIncidentMonitors.$inferSelect;

const im = schema.statusIncidentMonitors;
const i = schema.statusIncidents;

/** Data access for mocco_status_incident_monitors. Scoped by workspace. */
export class IncidentMonitorRepo {
  constructor(private readonly db: Db) {}

  /** The incident the monitor opened and hasn't closed yet, if any (at most one, by the partial unique index). */
  async findOpen(workspaceId: string, monitorId: string): Promise<IncidentRow | undefined> {
    const [row] = await this.db
      .select({ incident: i })
      .from(im)
      .innerJoin(i, and(eq(i.id, im.incidentId), eq(i.workspaceId, im.workspaceId)))
      .where(and(eq(im.workspaceId, workspaceId), eq(im.monitorId, monitorId), isNull(im.closedAt)));
    return row?.incident;
  }

  async insert(row: typeof im.$inferInsert): Promise<IncidentMonitorRow> {
    return expectOne(await this.db.insert(im).values(row).returning());
  }

  async close(workspaceId: string, incidentId: string, monitorId: string, at: Date): Promise<void> {
    await this.db
      .update(im)
      .set({ closedAt: at })
      .where(
        and(
          eq(im.workspaceId, workspaceId),
          eq(im.incidentId, incidentId),
          eq(im.monitorId, monitorId),
          isNull(im.closedAt),
        ),
      );
  }
}
