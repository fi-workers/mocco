// The project's monitors (#150), the status section's monitors view: each monitor's state,
// target (or, for a heartbeat, its period and last ping), last change and the components it
// reports on, and creating a new one. Monitors
// belong to the project, so the view is the same on every page.
import { MonitorKinds } from '@mocco/common/status';
import Link from 'next/link';
import { useState } from 'react';

import { Ago, errorMessage, Spinner } from '@frontend/components/notifications/notification-ui';
import { formatSpan } from '@frontend/components/status/heartbeat-ping';
import MonitorForm from '@frontend/components/status/monitor-form';
import { useProjectComponents } from '@frontend/components/status/project-components';
import { MonitorStateBadge, monitorTargetLabel } from '@frontend/components/status/status-ui';
import { Button } from '@frontend/components/ui/button';
import { Routes } from '@frontend/lib/routes';
import { trpc } from '@frontend/lib/trpc';

interface Props {
  workspaceId: string;
  projectId: string;
}

/** How often the view rereads states while it is open; the evaluator closes a round every minute. */
export const MONITOR_REFRESH_MS = 15_000;

export default function Monitors({ workspaceId, projectId }: Props) {
  const [isCreating, setIsCreating] = useState(false);
  const monitorsQuery = trpc.status.monitors.useQuery(
    { workspaceId, projectId },
    { refetchInterval: MONITOR_REFRESH_MS },
  );
  const { names } = useProjectComponents(workspaceId, projectId);
  const monitors = monitorsQuery.data?.monitors ?? [];

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-prose text-sm text-muted-foreground">
          Monitors check your service from probe locations, or wait for your jobs&apos; heartbeat pings, and change what
          its components show when it fails.
        </p>
        {isCreating ? null : (
          <Button
            className="text-sm"
            onClick={() => {
              setIsCreating(true);
            }}>
            New monitor
          </Button>
        )}
      </div>
      {isCreating ? (
        <MonitorForm
          workspaceId={workspaceId}
          projectId={projectId}
          onDone={() => {
            setIsCreating(false);
          }}
        />
      ) : null}
      {monitorsQuery.isPending ? <Spinner /> : null}
      {monitorsQuery.error ? <p className="text-sm text-destructive">{errorMessage(monitorsQuery.error)}</p> : null}
      {!monitorsQuery.isPending && monitors.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          No monitors yet.
        </p>
      ) : null}
      {monitors.length === 0 ? null : (
        <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
          {monitors.map(monitor => (
            <li key={monitor.id}>
              <Link
                href={Routes.projectStatusMonitor(workspaceId, projectId, monitor.id)}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 hover:bg-muted/40">
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-sm font-medium">{monitor.name}</span>
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {monitor.kind === MonitorKinds.heartbeat ? (
                      <>
                        Heartbeat every {formatSpan(monitor.heartbeatPeriodSeconds ?? 0)} · last ping{' '}
                        {monitor.lastPingAt === null ? 'never' : <Ago date={monitor.lastPingAt} />}
                      </>
                    ) : (
                      monitorTargetLabel(monitor.spec)
                    )}
                  </span>
                </span>
                {monitor.components.length === 0 ? null : (
                  <span className="text-xs text-muted-foreground">
                    {monitor.components.map(link => names.get(link.componentId) ?? 'Component').join(', ')}
                  </span>
                )}
                <MonitorStateBadge state={monitor.state} />
                <span className="text-xs text-muted-foreground">
                  Since <Ago date={monitor.stateChangedAt} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
