import { RunStates } from '@mocco/common/execution';
import Link from 'next/link';

import { Ago, Notice, Spinner, StatusBadge, Tones } from '@frontend/components/notifications/notification-ui';
import { Routes } from '@frontend/lib/routes';
import { trpc } from '@frontend/lib/trpc';

import type { Tone } from '@frontend/components/notifications/notification-ui';
import type { RunState } from '@mocco/common/execution';

/** How each run state reads in a list. A Record, so a new state can't ship unlabeled. */
const runStateDisplay: Readonly<Record<RunState, { label: string; tone: Tone }>> = {
  [RunStates.queued]: { label: 'Queued', tone: Tones.neutral },
  [RunStates.running]: { label: 'Running', tone: Tones.neutral },
  [RunStates.awaitingGate]: { label: 'Waiting at a gate', tone: Tones.warn },
  [RunStates.succeeded]: { label: 'Succeeded', tone: Tones.ok },
  [RunStates.failed]: { label: 'Failed', tone: Tones.danger },
  [RunStates.rejected]: { label: 'Rejected at a gate', tone: Tones.danger },
  [RunStates.canceled]: { label: 'Canceled', tone: Tones.neutral },
};

const RECENT_RUNS = 10;

// The workspace's latest pipeline runs across repositories, newest first — what the
// Deploys page leads with, each linking to its run.
export function RecentRuns({ workspaceId }: { workspaceId: string }) {
  const runsQuery = trpc.run.list.useQuery({ workspaceId, limit: RECENT_RUNS });
  const runs = runsQuery.data?.runs ?? [];

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium">Recent runs</h2>
      {runsQuery.isPending ? <Spinner /> : null}
      {runsQuery.isError ? (
        <Notice tone={Tones.danger} title="Couldn’t load the runs">
          {runsQuery.error.message}
        </Notice>
      ) : null}
      {runsQuery.isSuccess && runs.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          No runs yet. A run starts when a commit on a watched branch is triggered.
        </p>
      ) : null}
      {runs.length > 0 ? (
        <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
          {runs.map(run => {
            const display = runStateDisplay[run.state];
            return (
              <li key={run.id}>
                <Link
                  href={Routes.workspaceRun(workspaceId, run.id)}
                  className="flex items-center gap-3 px-4 py-3 transition hover:bg-muted">
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium">{run.message.split('\n', 1)[0]}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {run.repo} · {run.branch} · <span className="font-mono">{run.sha.slice(0, 7)}</span> ·{' '}
                      <Ago date={run.createdAt} />
                    </span>
                  </span>
                  <StatusBadge tone={display.tone}>{display.label}</StatusBadge>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
