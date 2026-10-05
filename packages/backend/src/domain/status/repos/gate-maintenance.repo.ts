import { and, asc, eq, inArray } from 'drizzle-orm';

import { expectOne } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { StatusScope } from '@backend/domain/status/scope';
import type { Db } from '@backend/infra/db/types';

export type GateMaintenanceRow = typeof schema.statusGateMaintenances.$inferSelect;

const g = schema.statusGateMaintenances;
const scoped = (scope: StatusScope) => and(eq(g.workspaceId, scope.workspaceId), eq(g.projectId, scope.projectId));

/** Data access for mocco_status_gate_maintenances. Scoped by workspace and project, except
 * `listForGate`, which a resumed gate reads across the projects its repository is linked to. */
export class GateMaintenanceRepo {
  constructor(private readonly db: Db) {}

  async listForPage(scope: StatusScope, pageId: string): Promise<GateMaintenanceRow[]> {
    return await this.db
      .select()
      .from(g)
      .where(and(scoped(scope), eq(g.pageId, pageId)))
      .orderBy(asc(g.gateName));
  }

  /** The workspace's gate maintenances named `gateName` on the pages of `projectIds`. */
  async listForGate(
    workspaceId: string,
    projectIds: readonly string[],
    gateName: string,
  ): Promise<GateMaintenanceRow[]> {
    if (projectIds.length === 0) {
      return [];
    }
    return await this.db
      .select()
      .from(g)
      .where(and(eq(g.workspaceId, workspaceId), inArray(g.projectId, [...projectIds]), eq(g.gateName, gateName)));
  }

  /** Create the page's gate maintenance for the gate name, or replace the one it has. */
  async upsert(row: typeof g.$inferInsert): Promise<GateMaintenanceRow> {
    return expectOne(
      await this.db
        .insert(g)
        .values(row)
        .onConflictDoUpdate({
          target: [g.pageId, g.gateName],
          set: {
            title: row.title,
            expectedMinutes: row.expectedMinutes,
            componentIds: row.componentIds,
            updatedAt: new Date(),
          },
        })
        .returning(),
    );
  }

  /** Delete one; undefined when the project has none with the id. */
  async delete(scope: StatusScope, id: string): Promise<GateMaintenanceRow | undefined> {
    const [row] = await this.db
      .delete(g)
      .where(and(scoped(scope), eq(g.id, id)))
      .returning();
    return row;
  }
}
