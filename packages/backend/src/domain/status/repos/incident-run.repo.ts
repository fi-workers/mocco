import { IncidentRunRelations } from '@mocco/common/status';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';

import { expectOne } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

export type IncidentRunRow = typeof schema.statusIncidentRuns.$inferSelect;

const ir = schema.statusIncidentRuns;
const i = schema.statusIncidents;

/** The relations Mocco suggests; a person's `manual` and `fix` links are never replaced by them. */
const SUGGESTED = [IncidentRunRelations.suspected, IncidentRunRelations.beforeWindow];

/** Data access for mocco_status_incident_runs. Scoped by workspace. */
export class IncidentRunRepo {
  constructor(private readonly db: Db) {}

  /** The incident's runs: the highest score first, then a person's links, newest first. */
  async listForIncident(workspaceId: string, incidentId: string): Promise<IncidentRunRow[]> {
    return await this.db
      .select()
      .from(ir)
      .where(and(eq(ir.workspaceId, workspaceId), eq(ir.incidentId, incidentId)))
      .orderBy(sql`${ir.score} DESC NULLS LAST`, desc(ir.createdAt));
  }

  /** The incidents a run is linked to, with the link, newest incident first. */
  async listForRun(workspaceId: string, runId: string) {
    return await this.db
      .select({ incident: i, link: ir })
      .from(ir)
      .innerJoin(i, and(eq(i.id, ir.incidentId), eq(i.workspaceId, ir.workspaceId)))
      .where(and(eq(ir.workspaceId, workspaceId), eq(ir.runId, runId)))
      .orderBy(desc(i.startedAt), asc(i.id));
  }

  async find(workspaceId: string, incidentId: string, runId: string): Promise<IncidentRunRow | undefined> {
    const [row] = await this.db
      .select()
      .from(ir)
      .where(and(eq(ir.workspaceId, workspaceId), eq(ir.incidentId, incidentId), eq(ir.runId, runId)));
    return row;
  }

  /** Replace the incident's suggested links with `rows`; a run a person already linked keeps their link. */
  async replaceSuggestions(workspaceId: string, incidentId: string, rows: (typeof ir.$inferInsert)[]): Promise<void> {
    await this.db
      .delete(ir)
      .where(and(eq(ir.workspaceId, workspaceId), eq(ir.incidentId, incidentId), inArray(ir.relation, SUGGESTED)));
    if (rows.length > 0) {
      await this.db.insert(ir).values(rows).onConflictDoNothing();
    }
  }

  /** Link a run as a person did: a suggestion for the same run becomes their link. */
  async upsertLink(row: typeof ir.$inferInsert): Promise<IncidentRunRow> {
    return expectOne(
      await this.db
        .insert(ir)
        .values(row)
        .onConflictDoUpdate({
          target: [ir.incidentId, ir.runId],
          set: { relation: row.relation, score: null, linkedByUserId: row.linkedByUserId, createdAt: new Date() },
        })
        .returning(),
    );
  }

  /** Remove a link; returns it, or undefined when there was none. */
  async delete(workspaceId: string, incidentId: string, runId: string): Promise<IncidentRunRow | undefined> {
    const [row] = await this.db
      .delete(ir)
      .where(and(eq(ir.workspaceId, workspaceId), eq(ir.incidentId, incidentId), eq(ir.runId, runId)))
      .returning();
    return row;
  }
}
