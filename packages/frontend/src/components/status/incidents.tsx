// A status page's incidents (#148): the open or resolved ones (`?filter=`), newest first, and
// declaring a new one with its severity, first update and affected components.
import {
  IncidentSeverities,
  incidentSeveritySchema,
  IncidentStatuses,
  incidentStatusSchema,
} from '@mocco/common/status';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useState } from 'react';

import {
  Ago,
  errorMessage,
  inputClass,
  labelClass,
  Spinner,
  StatusBadge,
  Tones,
} from '@frontend/components/notifications/notification-ui';
import AffectedComponentsPicker from '@frontend/components/status/affected-components';
import {
  IncidentFilters,
  incidentSeverityLabels,
  IncidentStatusBadge,
  incidentStatusLabels,
  StatusTabs,
} from '@frontend/components/status/status-ui';
import { Button } from '@frontend/components/ui/button';
import { Routes } from '@frontend/lib/routes';
import { trpc } from '@frontend/lib/trpc';

import type { IncidentFilter } from '@frontend/components/status/status-ui';
import type { AffectedComponent, IncidentSeverity, IncidentStatus } from '@mocco/common/status';

interface Props {
  workspaceId: string;
  projectId: string;
  pageId: string;
}

// eslint-disable-next-line sonarjs/null-dereference -- value is a string, never null
const isBlank = (value: string) => value.trim() === '';

/** The statuses an incident can be opened in: anything but resolved. */
const openingStatusSchema = incidentStatusSchema.exclude([IncidentStatuses.resolved]);
type OpeningStatus = Exclude<IncidentStatus, typeof IncidentStatuses.resolved>;
const OPENING_STATUSES = openingStatusSchema.options;

function DeclareIncident({ workspaceId, projectId, pageId, onDone }: Props & { onDone: () => void }) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const pageQuery = trpc.status.page.useQuery({ workspaceId, projectId, pageId });
  const [title, setTitle] = useState('');
  const [severity, setSeverity] = useState<IncidentSeverity>(IncidentSeverities.minor);
  const [status, setStatus] = useState<OpeningStatus>(IncidentStatuses.investigating);
  const [body, setBody] = useState('');
  const [components, setComponents] = useState<AffectedComponent[]>([]);
  const create = trpc.status.createIncident.useMutation({
    onSuccess: async ({ incident }) => {
      await Promise.all([utils.status.incidents.invalidate(), utils.status.page.invalidate()]);
      await router.push(Routes.projectStatusIncident(workspaceId, projectId, incident.id));
    },
  });

  return (
    <form
      aria-label="Declare an incident"
      className="flex max-w-xl flex-col gap-4 rounded-xl border border-border p-4"
      onSubmit={event => {
        event.preventDefault();
        create.mutate({ workspaceId, projectId, pageId, title, severity, status, body, components });
      }}>
      <h3 className="text-sm font-medium">Declare an incident</h3>
      <label className={labelClass}>
        Title
        <input
          className={inputClass}
          placeholder="Elevated error rates on the API"
          value={title}
          maxLength={120}
          onChange={event => {
            setTitle(event.target.value);
          }}
        />
      </label>
      <div className="flex flex-wrap gap-4">
        <label className={labelClass}>
          Severity
          <select
            className={inputClass}
            value={severity}
            onChange={event => {
              const parsed = incidentSeveritySchema.safeParse(event.target.value);
              if (parsed.success) {
                setSeverity(parsed.data);
              }
            }}>
            {Object.values(IncidentSeverities).map(value => (
              <option key={value} value={value}>
                {incidentSeverityLabels[value]}
              </option>
            ))}
          </select>
        </label>
        <label className={labelClass}>
          Status
          <select
            className={inputClass}
            value={status}
            onChange={event => {
              const parsed = openingStatusSchema.safeParse(event.target.value);
              if (parsed.success) {
                setStatus(parsed.data);
              }
            }}>
            {OPENING_STATUSES.map(value => (
              <option key={value} value={value}>
                {incidentStatusLabels[value]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className={labelClass}>
        First update
        <textarea
          className={`${inputClass} h-24 py-1.5`}
          placeholder="We are investigating elevated error rates on the API."
          value={body}
          onChange={event => {
            setBody(event.target.value);
          }}
        />
      </label>
      {pageQuery.data ? (
        <AffectedComponentsPicker components={pageQuery.data.components} value={components} onChange={setComponents} />
      ) : (
        <Spinner />
      )}
      {create.error ? <p className="text-sm text-destructive">{errorMessage(create.error)}</p> : null}
      <span className="flex flex-wrap gap-2">
        <Button type="submit" className="text-sm" pending={create.isPending} disabled={isBlank(title) || isBlank(body)}>
          Declare incident
        </Button>
        <Button type="button" variant="ghost" className="text-sm" onClick={onDone}>
          Cancel
        </Button>
      </span>
    </form>
  );
}

export default function Incidents({ workspaceId, projectId, pageId }: Props) {
  const router = useRouter();
  const [isDeclaring, setIsDeclaring] = useState(false);
  const filter: IncidentFilter =
    router.query.filter === IncidentFilters.resolved ? IncidentFilters.resolved : IncidentFilters.open;
  const isOpenFilter = filter === IncidentFilters.open;
  const incidentsQuery = trpc.status.incidents.useQuery({ workspaceId, projectId, pageId, openOnly: isOpenFilter });
  const incidents = (incidentsQuery.data?.incidents ?? []).filter(
    incident => isOpenFilter || incident.status === IncidentStatuses.resolved,
  );

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <nav aria-label="Incident status" className="flex gap-1 border-b border-border">
          {Object.values(IncidentFilters).map(value => (
            <Link
              key={value}
              href={Routes.projectStatus(workspaceId, projectId, pageId, { tab: StatusTabs.incidents, filter: value })}
              aria-current={value === filter ? 'page' : undefined}
              className={`-mb-px border-b-2 px-3 py-1.5 text-sm ${
                value === filter ? 'border-foreground font-medium' : 'border-transparent text-muted-foreground'
              }`}>
              {value === IncidentFilters.open ? 'Open' : 'Resolved'}
            </Link>
          ))}
        </nav>
        {isDeclaring ? null : (
          <Button
            className="text-sm"
            onClick={() => {
              setIsDeclaring(true);
            }}>
            Declare incident
          </Button>
        )}
      </div>
      {isDeclaring ? (
        <DeclareIncident
          workspaceId={workspaceId}
          projectId={projectId}
          pageId={pageId}
          onDone={() => {
            setIsDeclaring(false);
          }}
        />
      ) : null}
      {incidentsQuery.isPending ? <Spinner /> : null}
      {incidentsQuery.error ? <p className="text-sm text-destructive">{errorMessage(incidentsQuery.error)}</p> : null}
      {!incidentsQuery.isPending && incidents.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          {isOpenFilter ? 'No open incidents. Everything is running as reported.' : 'No resolved incidents yet.'}
        </p>
      ) : null}
      {incidents.length === 0 ? null : (
        <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
          {incidents.map(incident => (
            <li key={incident.id}>
              <Link
                href={Routes.projectStatusIncident(workspaceId, projectId, incident.id)}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 hover:bg-muted/40">
                <span className="min-w-0 flex-1 text-sm font-medium">{incident.title}</span>
                <StatusBadge tone={incident.severity === IncidentSeverities.minor ? Tones.neutral : Tones.danger}>
                  {incidentSeverityLabels[incident.severity]}
                </StatusBadge>
                <IncidentStatusBadge status={incident.status} />
                <span className="text-xs text-muted-foreground">
                  {incident.resolvedAt === null ? 'Started ' : 'Resolved '}
                  <Ago date={incident.resolvedAt ?? incident.startedAt} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
