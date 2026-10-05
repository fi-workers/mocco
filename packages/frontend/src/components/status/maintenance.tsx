// A status page's maintenance windows (#148): what is in progress now, what is scheduled, and
// what is past; scheduling a window with the components it covers, and canceling one. Mocco
// starts and completes windows on their own every minute. A window a resumed gate started (#158)
// links to its run, says when it overran its expected minutes, and why it ended early.
import { MaintenanceStatuses } from '@mocco/common/status';
import Link from 'next/link';
import { useState } from 'react';

import {
  errorMessage,
  inputClass,
  labelClass,
  Spinner,
  StatusBadge,
  Tones,
} from '@frontend/components/notifications/notification-ui';
import GateMaintenances from '@frontend/components/status/gate-maintenances';
import { formatWhen, MaintenanceStatusBadge } from '@frontend/components/status/status-ui';
import { Button } from '@frontend/components/ui/button';
import { Routes } from '@frontend/lib/routes';
import { trpc } from '@frontend/lib/trpc';

import type { StatusOutputs } from '@frontend/components/status/status-ui';

interface Props {
  workspaceId: string;
  projectId: string;
  pageId: string;
}

type Window = StatusOutputs['maintenances']['maintenances'][number];
type Component = StatusOutputs['page']['components'][number];

// eslint-disable-next-line sonarjs/null-dereference -- value is a string, never null
const isBlank = (value: string) => value.trim() === '';

const HOUR = 60 * 60 * 1000;

/** A `datetime-local` value for `date` in the viewer's time zone (minutes precision). */
function toLocalInput(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

/** The date a `datetime-local` value means in the viewer's time zone; null when it's empty or invalid. */
function fromLocalInput(value: string): Date | null {
  const date = new Date(value);
  return value === '' || Number.isNaN(date.getTime()) ? null : date;
}

function ScheduleMaintenance({
  workspaceId,
  projectId,
  pageId,
  components,
  onDone,
}: Props & { components: readonly Component[]; onDone: () => void }) {
  const utils = trpc.useUtils();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  // The next full hour, for an hour.
  const [start, setStart] = useState(() => toLocalInput(new Date(Math.ceil(Date.now() / HOUR) * HOUR)));
  const [end, setEnd] = useState(() => toLocalInput(new Date(Math.ceil(Date.now() / HOUR) * HOUR + HOUR)));
  const [componentIds, setComponentIds] = useState<string[]>([]);
  const schedule = trpc.status.scheduleMaintenance.useMutation({
    onSuccess: async () => {
      await utils.status.maintenances.invalidate();
      onDone();
    },
  });
  const scheduledStart = fromLocalInput(start);
  const scheduledEnd = fromLocalInput(end);
  const isOrdered = scheduledStart !== null && scheduledEnd !== null && scheduledEnd > scheduledStart;
  const toggle = (componentId: string, isOn: boolean) => {
    setComponentIds(current => (isOn ? [...current, componentId] : current.filter(id => id !== componentId)));
  };

  return (
    <form
      aria-label="Schedule maintenance"
      className="flex max-w-xl flex-col gap-4 rounded-xl border border-border p-4"
      onSubmit={event => {
        event.preventDefault();
        if (scheduledStart !== null && scheduledEnd !== null) {
          schedule.mutate({ workspaceId, projectId, pageId, title, body, scheduledStart, scheduledEnd, componentIds });
        }
      }}>
      <h3 className="text-sm font-medium">Schedule maintenance</h3>
      <label className={labelClass}>
        Title
        <input
          className={inputClass}
          placeholder="Database upgrade"
          value={title}
          maxLength={120}
          onChange={event => {
            setTitle(event.target.value);
          }}
        />
      </label>
      <div className="flex flex-wrap gap-4">
        <label className={labelClass}>
          Starts
          <input
            type="datetime-local"
            className={inputClass}
            value={start}
            onChange={event => {
              setStart(event.target.value);
            }}
          />
        </label>
        <label className={labelClass}>
          Ends
          <input
            type="datetime-local"
            className={inputClass}
            value={end}
            aria-invalid={!isOrdered}
            onChange={event => {
              setEnd(event.target.value);
            }}
          />
        </label>
      </div>
      {isOrdered ? null : <p className="text-xs text-destructive">The window ends after it starts.</p>}
      <label className={labelClass}>
        Details (optional)
        <textarea
          className={`${inputClass} h-20 py-1.5`}
          placeholder="The API may answer slowly for a few minutes while we switch over."
          value={body}
          onChange={event => {
            setBody(event.target.value);
          }}
        />
      </label>
      {components.length === 0 ? null : (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-xs font-medium text-muted-foreground">Components under maintenance</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {components.map(component => (
              <label key={component.id} className="flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  checked={componentIds.includes(component.id)}
                  onChange={event => {
                    toggle(component.id, event.target.checked);
                  }}
                />
                {component.name}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {schedule.error ? <p className="text-sm text-destructive">{errorMessage(schedule.error)}</p> : null}
      <span className="flex flex-wrap gap-2">
        <Button type="submit" className="text-sm" pending={schedule.isPending} disabled={isBlank(title) || !isOrdered}>
          Schedule
        </Button>
        <Button type="button" variant="ghost" className="text-sm" onClick={onDone}>
          Cancel
        </Button>
      </span>
    </form>
  );
}

/** For a window a resumed gate started: its run, and when it overran. */
function RunLine({ workspaceId, maintenance }: { workspaceId: string; maintenance: Window }) {
  if (maintenance.runId === null) {
    return null;
  }
  return (
    <p className="text-xs text-muted-foreground">
      Started when a gate was resumed on{' '}
      <Link
        href={Routes.workspaceRun(workspaceId, maintenance.runId)}
        className="font-medium text-foreground underline-offset-2 hover:underline">
        this run
      </Link>
      {maintenance.overranAt === null ? '' : ` · ran past its expected end at ${formatWhen(maintenance.overranAt)}`}
      {maintenance.overranAt !== null && maintenance.status === MaintenanceStatuses.inProgress
        ? ', so it stays open until the run finishes'
        : ''}
    </p>
  );
}

function WindowRow({
  workspaceId,
  projectId,
  maintenance,
  components,
}: Omit<Props, 'pageId'> & { maintenance: Window; components: readonly Component[] }) {
  const utils = trpc.useUtils();
  const [isConfirming, setIsConfirming] = useState(false);
  const cancel = trpc.status.cancelMaintenance.useMutation({
    onSuccess: async () => {
      setIsConfirming(false);
      await Promise.all([utils.status.maintenances.invalidate(), utils.status.page.invalidate()]);
    },
  });
  const isCancelable =
    maintenance.status === MaintenanceStatuses.scheduled || maintenance.status === MaintenanceStatuses.inProgress;
  const names = maintenance.componentIds.map(
    id => components.find(component => component.id === id)?.name ?? 'Deleted',
  );

  return (
    <li className="flex flex-col gap-1.5 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="min-w-0 flex-1 text-sm font-medium">{maintenance.title}</span>
        {maintenance.overranAt === null ? null : <StatusBadge tone={Tones.warn}>Overran</StatusBadge>}
        <MaintenanceStatusBadge status={maintenance.status} />
        {isCancelable && isConfirming ? (
          <span className="flex gap-1">
            <Button
              variant="destructive"
              size="sm"
              pending={cancel.isPending}
              onClick={() => {
                cancel.mutate({ workspaceId, projectId, maintenanceId: maintenance.id });
              }}>
              {maintenance.status === MaintenanceStatuses.inProgress ? 'End it now' : 'Cancel window'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setIsConfirming(false);
              }}>
              Keep
            </Button>
          </span>
        ) : null}
        {isCancelable && !isConfirming ? (
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Cancel ${maintenance.title}`}
            onClick={() => {
              setIsConfirming(true);
            }}>
            Cancel
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        {formatWhen(maintenance.scheduledStart)} – {formatWhen(maintenance.scheduledEnd)}
        {maintenance.actualStart === null ? '' : ` · started ${formatWhen(maintenance.actualStart)}`}
        {maintenance.actualEnd === null ? '' : ` · ended ${formatWhen(maintenance.actualEnd)}`}
      </p>
      {names.length === 0 ? null : <p className="text-xs text-muted-foreground">Covers {names.join(', ')}</p>}
      <RunLine workspaceId={workspaceId} maintenance={maintenance} />
      {maintenance.endNote === null ? null : <p className="text-xs text-muted-foreground">{maintenance.endNote}</p>}
      {maintenance.bodyMd === '' ? null : <p className="text-sm whitespace-pre-wrap">{maintenance.bodyMd}</p>}
      {cancel.error ? <p className="text-sm text-destructive">{errorMessage(cancel.error)}</p> : null}
    </li>
  );
}

function WindowList({
  title,
  empty,
  windows,
  workspaceId,
  projectId,
  components,
}: Omit<Props, 'pageId'> & {
  title: string;
  empty: string;
  windows: readonly Window[];
  components: readonly Component[];
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">{title}</h3>
      {windows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
          {windows.map(maintenance => (
            <WindowRow
              key={maintenance.id}
              workspaceId={workspaceId}
              projectId={projectId}
              components={components}
              maintenance={maintenance}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

export default function Maintenance({ workspaceId, projectId, pageId }: Props) {
  const [isScheduling, setIsScheduling] = useState(false);
  const windowsQuery = trpc.status.maintenances.useQuery({ workspaceId, projectId, pageId });
  const pageQuery = trpc.status.page.useQuery({ workspaceId, projectId, pageId });
  if (windowsQuery.isPending || pageQuery.isPending) {
    return <Spinner />;
  }
  if (windowsQuery.error) {
    return <p className="text-sm text-destructive">{errorMessage(windowsQuery.error)}</p>;
  }
  const windows = windowsQuery.data.maintenances;
  const components = pageQuery.data?.components ?? [];
  const listProps = { workspaceId, projectId, components };
  const inStatus = (...statuses: Window['status'][]) =>
    windows.filter(maintenance => statuses.includes(maintenance.status));

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="max-w-prose text-sm text-muted-foreground">
          Mocco starts a window at its start time and completes it at its end, checking every minute. While a window is
          in progress, the components it covers show as under maintenance. To change a window, cancel it and schedule a
          new one. Gates that announce maintenance, below, start a window when a run resumes them.
        </p>
        {isScheduling ? null : (
          <Button
            className="text-sm"
            onClick={() => {
              setIsScheduling(true);
            }}>
            Schedule maintenance
          </Button>
        )}
      </div>
      {isScheduling ? (
        <ScheduleMaintenance
          workspaceId={workspaceId}
          projectId={projectId}
          pageId={pageId}
          components={components}
          onDone={() => {
            setIsScheduling(false);
          }}
        />
      ) : null}
      <WindowList
        title="In progress"
        empty="No maintenance is in progress."
        windows={inStatus(MaintenanceStatuses.inProgress)}
        {...listProps}
      />
      <WindowList
        title="Scheduled"
        empty="Nothing is scheduled."
        windows={inStatus(MaintenanceStatuses.scheduled)}
        {...listProps}
      />
      <WindowList
        title="Past"
        empty="No past maintenance."
        windows={inStatus(MaintenanceStatuses.completed, MaintenanceStatuses.canceled)}
        {...listProps}
      />
      <GateMaintenances workspaceId={workspaceId} projectId={projectId} pageId={pageId} components={components} />
    </section>
  );
}
