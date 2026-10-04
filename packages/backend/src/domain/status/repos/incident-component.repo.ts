import { IncidentStatuses } from '@mocco/common/status';
import { and, eq, ne } from 'drizzle-orm';

import * as schema from '@backend/infra/db/schema';

import type { StatusScope } from '@backend/domain/status/scope';
import type { Db } from '@backend/infra/db/types';
import type { AffectedComponent } from '@mocco/common/status';

export type IncidentComponentRow = typeof schema.statusIncidentComponents.$inferSelect;

const ic = schema.statusIncidentComponents;
const i = schema.statusIncidents;

/** Data access for mocco_status_incident_components. Scoped by workspace. */
export class IncidentComponentRepo {
  constructor(private readonly db: Db) {}

  async listForIncident(workspaceId: string, incidentId: string): Promise<IncidentComponentRow[]> {
    return await this.db
      .select()
      .from(ic)
      .where(and(eq(ic.workspaceId, workspaceId), eq(ic.incidentId, incidentId)));
  }

  /** Replace the incident's affected components with `components` (a repeated component keeps
   * its last impact). Run it inside a transaction. */
  async replace(workspaceId: string, incidentId: string, components: readonly AffectedComponent[]): Promise<void> {
    await this.db.delete(ic).where(and(eq(ic.workspaceId, workspaceId), eq(ic.incidentId, incidentId)));
    const byId = new Map(components.map(component => [component.componentId, component.impact]));
    if (byId.size > 0) {
      await this.db
        .insert(ic)
        .values([...byId].map(([componentId, impact]) => ({ workspaceId, incidentId, componentId, impact })));
    }
  }

  /** The impacts unresolved incidents put on a page's components. */
  async openImpactsForPage(scope: StatusScope, pageId: string) {
    return await this.db
      .select({ componentId: ic.componentId, impact: ic.impact })
      .from(ic)
      .innerJoin(i, and(eq(i.id, ic.incidentId), eq(i.workspaceId, ic.workspaceId)))
      .where(
        and(
          eq(i.workspaceId, scope.workspaceId),
          eq(i.projectId, scope.projectId),
          eq(i.pageId, pageId),
          ne(i.status, IncidentStatuses.resolved),
        ),
      );
  }
}
