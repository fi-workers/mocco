import { and, asc, eq, inArray } from 'drizzle-orm';

import { expectOne } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

export type IncidentUpdateRow = typeof schema.statusIncidentUpdates.$inferSelect;

const u = schema.statusIncidentUpdates;

/** Data access for mocco_status_incident_updates (append-only). Scoped by workspace. */
export class IncidentUpdateRepo {
  constructor(private readonly db: Db) {}

  /** An incident's timeline, oldest first. */
  async listForIncident(workspaceId: string, incidentId: string): Promise<IncidentUpdateRow[]> {
    return await this.db
      .select()
      .from(u)
      .where(and(eq(u.workspaceId, workspaceId), eq(u.incidentId, incidentId)))
      .orderBy(asc(u.createdAt));
  }

  /** The timelines of `incidentIds`, oldest first. */
  async listForIncidents(workspaceId: string, incidentIds: readonly string[]): Promise<IncidentUpdateRow[]> {
    if (incidentIds.length === 0) {
      return [];
    }
    return await this.db
      .select()
      .from(u)
      .where(and(eq(u.workspaceId, workspaceId), inArray(u.incidentId, [...incidentIds])))
      .orderBy(asc(u.createdAt));
  }

  async insert(row: typeof u.$inferInsert): Promise<IncidentUpdateRow> {
    return expectOne(await this.db.insert(u).values(row).returning());
  }
}
