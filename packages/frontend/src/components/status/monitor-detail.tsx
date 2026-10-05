// One monitor in the console (#150): its state and settings, a deploy watch in progress (#155),
// the incident it opened that is still open, its latest closed rounds and state changes, and
// editing, pausing, resuming or deleting it.
import { IncidentVisibilities, MonitorStates, RoundVerdicts } from '@mocco/common/status';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { z } from 'zod';

import {
  Ago,
  errorMessage,
  Notice,
  Spinner,
  StatusBadge,
  Tones,
} from '@frontend/components/notifications/notification-ui';
import MonitorForm from '@frontend/components/status/monitor-form';
import { MONITOR_REFRESH_MS } from '@frontend/components/status/monitors';
import { useProjectComponents } from '@frontend/components/status/project-components';
import {
  componentImpactLabels,
  formatWhen,
  IncidentStatusBadge,
  MonitorStateBadge,
  monitorTargetLabel,
  RoundVerdictBadge,
  roundVerdictLabels,
  StatusTabs,
} from '@frontend/components/status/status-ui';
import { Button } from '@frontend/components/ui/button';
import { Routes } from '@frontend/lib/routes';
import { trpc } from '@frontend/lib/trpc';

import type { StatusOutputs } from '@frontend/components/status/status-ui';

interface Props {
  workspaceId: string;
  projectId: string;
  monitorId: string;
}

type MonitorData = StatusOutputs['monitor'];

/** Why a state changed: a closed round's verdict, or an operator's pause or resume. */
const reasonSchema = z.union([
  z.object({
    by: z.literal('evaluator'),
    verdict: z.enum(RoundVerdicts),
    okCount: z.int(),
    failCount: z.int(),
    noDataCount: z.int(),
  }),
  z.object({ by: z.literal('operator') }),
]);

const countsOf = (counts: { okCount: number; failCount: number; noDataCount: number }) =>
  `${String(counts.okCount)} passed, ${String(counts.failCount)} failed, ${String(counts.noDataCount)} no data`;

function reasonText(reason: unknown): string {
  const parsed = reasonSchema.safeParse(reason);
  if (!parsed.success) {
    return '';
  }
  if (parsed.data.by === 'operator') {
    return 'By a person';
  }
  return `${roundVerdictLabels[parsed.data.verdict]}: ${countsOf(parsed.data)}`;
}

/** Whether a deploy watch is running: its window hasn't ended. */
const isWatching = (watchUntil: Date | null, now = Date.now()): watchUntil is Date =>
  watchUntil !== null && watchUntil.getTime() > now;

/** The release whose deploy watch is running, while it runs. */
function DeployWatch({ workspaceId, monitor }: { workspaceId: string; monitor: MonitorData['monitor'] }) {
  if (!isWatching(monitor.watchUntil)) {
    return null;
  }
  return (
    <Notice tone={Tones.neutral} title="Watching after a deploy">
      {monitor.watchRunId === null ? (
        'A release'
      ) : (
        <>
          Run{' '}
          <Link className="font-mono underline" href={Routes.workspaceRun(workspaceId, monitor.watchRunId)}>
            {monitor.watchRunId.slice(0, 8)}
          </Link>
        </>
      )}{' '}
      was released: this monitor checks every {String(monitor.watchIntervalSeconds ?? monitor.intervalSeconds)} s until{' '}
      {formatWhen(monitor.watchUntil)}, and going down meanwhile opens an incident naming the run.
    </Notice>
  );
}

function OpenIncident({
  workspaceId,
  projectId,
  incident,
}: {
  workspaceId: string;
  projectId: string;
  incident: NonNullable<MonitorData['openIncident']>;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium">Open incident</h2>
      <Link
        href={Routes.projectStatusIncident(workspaceId, projectId, incident.id)}
        className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-border px-4 py-3 hover:bg-muted/40">
        <span className="min-w-0 flex-1 text-sm font-medium">{incident.title}</span>
        {incident.visibility === IncidentVisibilities.draft ? (
          <StatusBadge tone={Tones.neutral}>Draft</StatusBadge>
        ) : null}
        <IncidentStatusBadge status={incident.status} />
        <span className="text-xs text-muted-foreground">
          Started <Ago date={incident.startedAt} />
        </span>
      </Link>
    </section>
  );
}

function Rounds({ verdicts }: { verdicts: MonitorData['recentVerdicts'] }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium">Latest rounds</h2>
      {verdicts.length === 0 ? (
        <p className="text-sm text-muted-foreground">No round has closed yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
          {verdicts.map(verdict => (
            <li
              key={verdict.roundAt.toISOString()}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm">
              <span className="w-44 text-xs text-muted-foreground">{formatWhen(verdict.roundAt)}</span>
              <RoundVerdictBadge verdict={verdict.verdict} />
              <span className="flex-1 text-xs text-muted-foreground">{countsOf(verdict)}</span>
              {verdict.p50LatencyMs === null ? null : (
                <span className="font-mono text-xs text-muted-foreground">{String(verdict.p50LatencyMs)} ms</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function StateChanges({ changes }: { changes: MonitorData['stateChanges'] }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium">State changes</h2>
      {changes.length === 0 ? (
        <p className="text-sm text-muted-foreground">No change yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
          {changes.map(change => (
            <li key={change.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm">
              <span className="w-44 text-xs text-muted-foreground">{formatWhen(change.at)}</span>
              <span className="flex items-center gap-1.5">
                <MonitorStateBadge state={change.fromState} />
                <span aria-hidden="true" className="text-muted-foreground">
                  →
                </span>
                <span className="sr-only">to</span>
                <MonitorStateBadge state={change.toState} />
              </span>
              <span className="text-xs text-muted-foreground">{reasonText(change.reason)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function MonitorDetail({ workspaceId, projectId, monitorId }: Props) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const [isEditing, setIsEditing] = useState(false);
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const input = { workspaceId, projectId, monitorId };
  const monitorQuery = trpc.status.monitor.useQuery(input, { refetchInterval: MONITOR_REFRESH_MS });
  const locationsQuery = trpc.status.locations.useQuery({ workspaceId });
  const { names } = useProjectComponents(workspaceId, projectId);
  const refresh = async () => {
    await Promise.all([utils.status.monitor.invalidate(input), utils.status.monitors.invalidate()]);
  };
  const pause = trpc.status.pauseMonitor.useMutation({ onSuccess: refresh });
  const resume = trpc.status.resumeMonitor.useMutation({ onSuccess: refresh });
  const remove = trpc.status.deleteMonitor.useMutation({
    onSuccess: async () => {
      await utils.status.monitors.invalidate();
      await router.replace(Routes.projectStatus(workspaceId, projectId, undefined, { tab: StatusTabs.monitors }));
    },
  });
  const back = (
    <Link
      href={Routes.projectStatus(workspaceId, projectId, undefined, { tab: StatusTabs.monitors })}
      className="w-fit text-sm text-muted-foreground hover:text-foreground">
      ← Monitors
    </Link>
  );
  if (monitorQuery.isPending) {
    return <Spinner />;
  }
  if (monitorQuery.error) {
    return (
      <div className="flex flex-col gap-4">
        {back}
        <p className="text-sm text-destructive">{errorMessage(monitorQuery.error)}</p>
      </div>
    );
  }
  const { monitor, stateChanges, recentVerdicts, openIncident } = monitorQuery.data;
  const locationNames = new Map((locationsQuery.data?.locations ?? []).map(location => [location.id, location.name]));
  const isPaused = monitor.state === MonitorStates.paused;
  const actionError = pause.error ?? resume.error ?? remove.error;

  return (
    <div className="flex flex-col gap-6">
      {back}
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-lg font-semibold">{monitor.name}</h1>
          <MonitorStateBadge state={monitor.state} />
          <span className="text-xs text-muted-foreground">
            Since <Ago date={monitor.stateChangedAt} />
          </span>
        </div>
        <p className="font-mono text-xs text-muted-foreground">{monitorTargetLabel(monitor.spec)}</p>
        <dl className="grid max-w-2xl grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Checks</dt>
          <dd>
            Every {String(monitor.intervalSeconds)} s; down after {String(monitor.confirmations)} failed rounds, up
            after {String(monitor.recoveryConfirmations)} passing
          </dd>
          <dt className="text-muted-foreground">Locations</dt>
          <dd>{monitor.locationIds.map(id => locationNames.get(id) ?? 'Location').join(', ')}</dd>
          <dt className="text-muted-foreground">Components</dt>
          <dd>
            {monitor.components.length === 0
              ? 'None'
              : monitor.components
                  .map(
                    link =>
                      `${names.get(link.componentId) ?? 'Component'} (${componentImpactLabels[link.impactWhenDown]})`,
                  )
                  .join(', ')}
          </dd>
        </dl>
      </header>
      <DeployWatch workspaceId={workspaceId} monitor={monitor} />
      {isEditing ? (
        <MonitorForm
          workspaceId={workspaceId}
          projectId={projectId}
          monitor={monitor}
          onDone={() => {
            setIsEditing(false);
          }}
        />
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            className="text-sm"
            onClick={() => {
              setIsEditing(true);
            }}>
            Edit
          </Button>
          {isPaused ? (
            <Button
              variant="outline"
              className="text-sm"
              pending={resume.isPending}
              onClick={() => {
                resume.mutate(input);
              }}>
              Resume
            </Button>
          ) : (
            <Button
              variant="outline"
              className="text-sm"
              pending={pause.isPending}
              onClick={() => {
                pause.mutate(input);
              }}>
              Pause
            </Button>
          )}
          {isConfirmingDelete ? (
            <>
              <Button
                variant="destructive"
                className="text-sm"
                pending={remove.isPending}
                onClick={() => {
                  remove.mutate(input);
                }}>
                Delete {monitor.name}
              </Button>
              <Button
                variant="ghost"
                className="text-sm"
                onClick={() => {
                  setIsConfirmingDelete(false);
                }}>
                Cancel
              </Button>
            </>
          ) : (
            <Button
              variant="ghost"
              className="text-sm"
              onClick={() => {
                setIsConfirmingDelete(true);
              }}>
              Delete
            </Button>
          )}
        </div>
      )}
      {isConfirmingDelete ? (
        <p className="max-w-prose text-xs text-muted-foreground">
          Deleting the monitor deletes its state history. Incidents it opened stay.
        </p>
      ) : null}
      {actionError ? <p className="text-sm text-destructive">{errorMessage(actionError)}</p> : null}
      {openIncident === null ? null : (
        <OpenIncident workspaceId={workspaceId} projectId={projectId} incident={openIncident} />
      )}
      <Rounds verdicts={recentVerdicts} />
      <StateChanges changes={stateChanges} />
    </div>
  );
}
