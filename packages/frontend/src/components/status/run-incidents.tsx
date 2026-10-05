// The incidents a run is linked to (#154), on the run's page. Shown only when the workspace has
// the status product on; the read lives on the status router, so runs never depend on status.
import { Products } from '@mocco/common/project';
import Link from 'next/link';

import { errorMessage } from '@frontend/components/notifications/notification-ui';
import { IncidentRunRelationBadge } from '@frontend/components/status/recent-deploys';
import { formatWhen, IncidentStatusBadge } from '@frontend/components/status/status-ui';
import { Routes } from '@frontend/lib/routes';
import { trpc } from '@frontend/lib/trpc';

export default function RunIncidents({ workspaceId, runId }: { workspaceId: string; runId: string }) {
  const productsQuery = trpc.product.list.useQuery({ workspaceId });
  const isStatusOn = productsQuery.data?.products.includes(Products.status) ?? false;
  const incidentsQuery = trpc.status.runIncidents.useQuery(
    { workspaceId, runId },
    { enabled: isStatusOn, retry: false },
  );
  if (!isStatusOn) {
    return null;
  }
  const incidents = incidentsQuery.data?.incidents ?? [];
  return (
    <section aria-label="Incidents" className="flex flex-col gap-2">
      <h2 className="text-sm font-medium">Incidents</h2>
      {incidentsQuery.error ? <p className="text-sm text-destructive">{errorMessage(incidentsQuery.error)}</p> : null}
      {incidentsQuery.isSuccess && incidents.length === 0 ? (
        <p className="text-sm text-muted-foreground">No incident is linked to this run.</p>
      ) : null}
      <ul className="flex flex-col gap-1.5">
        {incidents.map(incident => (
          <li
            key={incident.incidentId}
            className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm">
            <Link
              href={Routes.projectStatusIncident(workspaceId, incident.projectId, incident.incidentId)}
              className="font-medium underline-offset-2 hover:underline">
              {incident.title}
            </Link>
            <IncidentStatusBadge status={incident.status} />
            <IncidentRunRelationBadge relation={incident.relation} />
            <span className="text-xs text-muted-foreground">started {formatWhen(incident.startedAt)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
