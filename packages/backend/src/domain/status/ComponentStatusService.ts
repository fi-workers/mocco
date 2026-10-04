// The status each component of a page shows, from its manual status, open incidents and
// maintenance in progress. Monitors join the derivation when they land.
import { deriveComponentStatus } from '@backend/domain/status/component-status';
import { ComponentRepo } from '@backend/domain/status/repos/component.repo';
import { IncidentComponentRepo } from '@backend/domain/status/repos/incident-component.repo';
import { MaintenanceComponentRepo } from '@backend/domain/status/repos/maintenance-component.repo';

import type { ComponentRow } from '@backend/domain/status/repos/component.repo';
import type { StatusScope } from '@backend/domain/status/scope';
import type { Db } from '@backend/infra/db/types';
import type { ComponentStatus } from '@mocco/common/status';

export class ComponentStatusService {
  constructor(private readonly deps: { db: Db }) {}

  /** The page's components, in order, each with the status it shows. The public page passes
   * `isPublishedOnly`, so a draft incident can't change what visitors see. */
  async forPage(
    scope: StatusScope,
    pageId: string,
    isPublishedOnly = false,
  ): Promise<(ComponentRow & { displayedStatus: ComponentStatus })[]> {
    const [components, impacts, inMaintenance] = await Promise.all([
      new ComponentRepo(this.deps.db).listForPage(scope, pageId),
      new IncidentComponentRepo(this.deps.db).openImpactsForPage(scope, pageId, isPublishedOnly),
      new MaintenanceComponentRepo(this.deps.db).inProgressComponentIds(scope, pageId),
    ]);
    const maintained = new Set(inMaintenance);
    return components.map(component => ({
      ...component,
      displayedStatus: deriveComponentStatus({
        manual: component.status,
        impacts: impacts.filter(row => row.componentId === component.id).map(row => row.impact),
        inMaintenance: maintained.has(component.id),
      }),
    }));
  }
}
