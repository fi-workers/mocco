// The allowlist projection from status rows to the public snapshot. Pure: SnapshotService reads
// the rows (published incidents only) and this picks each published field by name, so a column
// added later stays private until someone adds it here on purpose.
import { createHash } from 'node:crypto';

import { COMPONENT_STATUS_RANK, ComponentStatuses, MaintenanceStatuses } from '@mocco/common/status';

import { publicSnapshotSchema } from '@backend/domain/status/snapshot/format';

import type { ComponentGroupRow } from '@backend/domain/status/repos/component-group.repo';
import type { ComponentRow } from '@backend/domain/status/repos/component.repo';
import type { IncidentComponentRow } from '@backend/domain/status/repos/incident-component.repo';
import type { IncidentUpdateRow } from '@backend/domain/status/repos/incident-update.repo';
import type { IncidentRow } from '@backend/domain/status/repos/incident.repo';
import type { MaintenanceComponentRow } from '@backend/domain/status/repos/maintenance-component.repo';
import type { MaintenanceRow } from '@backend/domain/status/repos/maintenance.repo';
import type { StatusPageRow } from '@backend/domain/status/repos/page.repo';
import type { PublicIncident, PublicSnapshot } from '@backend/domain/status/snapshot/format';
import type { ComponentStatus } from '@mocco/common/status';

type ShownComponent = ComponentRow & { displayedStatus: ComponentStatus };

export interface SnapshotRows {
  page: Pick<StatusPageRow, 'slug' | 'title'>;
  groups: readonly ComponentGroupRow[];
  /** Each with the status it shows, counting published incidents only. */
  components: readonly ShownComponent[];
  /** Published incidents only: the query leaves drafts out. */
  incidents: { open: readonly IncidentRow[]; resolved: readonly IncidentRow[] };
  updates: readonly IncidentUpdateRow[];
  incidentComponents: readonly IncidentComponentRow[];
  maintenances: readonly MaintenanceRow[];
  maintenanceComponents: readonly MaintenanceComponentRow[];
}

/** A stable public key for an incident (its feed entry id and anchor), not reversible to the row id. */
export function publicIncidentKey(incidentId: string): string {
  return createHash('sha256').update(`status-incident:${incidentId}`).digest('hex').slice(0, 16);
}

const toComponent = (component: ShownComponent) => ({
  id: component.id,
  name: component.name,
  description: component.description,
  status: component.displayedStatus,
  uptime: null,
});

export function projectSnapshot(rows: SnapshotRows, meta: { version: number; builtAt: Date }): PublicSnapshot {
  const nameOf = new Map(rows.components.map(component => [component.id, component.name]));
  const toIncident = (incident: IncidentRow): PublicIncident => ({
    key: publicIncidentKey(incident.id),
    title: incident.title,
    status: incident.status,
    severity: incident.severity,
    startedAt: incident.startedAt.toISOString(),
    resolvedAt: incident.resolvedAt?.toISOString() ?? null,
    components: rows.incidentComponents
      .filter(link => link.incidentId === incident.id)
      .map(link => ({ id: link.componentId, name: nameOf.get(link.componentId) ?? '', impact: link.impact })),
    updates: rows.updates
      .filter(update => update.incidentId === incident.id)
      .map(update => ({ status: update.status, body: update.bodyMd, at: update.createdAt.toISOString() }))
      .toReversed(),
  });
  const status = rows.components.reduce<ComponentStatus>(
    (worst, component) =>
      COMPONENT_STATUS_RANK[component.displayedStatus] > COMPONENT_STATUS_RANK[worst]
        ? component.displayedStatus
        : worst,
    ComponentStatuses.operational,
  );
  const sections = [
    {
      name: null,
      components: rows.components
        .filter(component => component.groupId === null)
        .map(component => toComponent(component)),
    },
    ...rows.groups.map(group => ({
      name: group.name,
      components: rows.components
        .filter(component => component.groupId === group.id)
        .map(component => toComponent(component)),
    })),
  ].filter(section => section.components.length > 0);
  const maintenances = rows.maintenances.flatMap(window =>
    window.status === MaintenanceStatuses.scheduled || window.status === MaintenanceStatuses.inProgress
      ? [
          {
            title: window.title,
            body: window.bodyMd,
            status: window.status,
            scheduledStart: window.scheduledStart.toISOString(),
            scheduledEnd: window.scheduledEnd.toISOString(),
            components: rows.maintenanceComponents
              .filter(link => link.maintenanceId === window.id)
              .map(link => ({ id: link.componentId, name: nameOf.get(link.componentId) ?? '' })),
          },
        ]
      : [],
  );
  // Parsing strips anything outside the format: a second guard behind the explicit picks above.
  return publicSnapshotSchema.parse({
    format: 1,
    version: meta.version,
    builtAt: meta.builtAt.toISOString(),
    page: { slug: rows.page.slug, title: rows.page.title },
    status,
    sections,
    incidents: rows.incidents.open.map(incident => toIncident(incident)),
    maintenances,
    history: rows.incidents.resolved.map(incident => toIncident(incident)),
  });
}
