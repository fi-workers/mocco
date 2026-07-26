import { RunStates, RunStepStatuses } from '@mocco/common/execution';

import { trpc } from '@frontend/lib/trpc';

import type { RunDto, RunState, RunStepDto, RunStepStatus } from '@mocco/common/execution';

/** Poll cadence for the live timeline. Fast enough to feel live, slow enough to be cheap. */
const POLL_MS = 1500;

/** States from which the run no longer changes — polling stops once reached. */
const TERMINAL_RUN_STATES = new Set<RunState>([RunStates.succeeded, RunStates.failed, RunStates.canceled]);

/** Tailwind tone per step status — a small visual cue on the timeline dot/label. */
const STEP_TONE: Record<RunStepStatus, string> = {
  [RunStepStatuses.pending]: 'text-muted-foreground',
  [RunStepStatuses.dispatched]: 'text-muted-foreground',
  [RunStepStatuses.running]: 'text-foreground',
  [RunStepStatuses.succeeded]: 'text-emerald-600 dark:text-emerald-400',
  [RunStepStatuses.failed]: 'text-destructive',
  [RunStepStatuses.skipped]: 'text-muted-foreground',
  [RunStepStatuses.canceled]: 'text-muted-foreground',
};

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <section className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-6 py-16 text-center">
      <h2 className="text-sm font-medium">{title}</h2>
      <p className="max-w-sm text-sm text-muted-foreground">{body}</p>
    </section>
  );
}

/** The run's identity, its current state, and — while running — a subtle "live"
 * hint. The hint is the ONLY refetch affordance: the timeline itself never blocks
 * on a background poll, it updates in place. */
function RunHeader({ run, isLive }: { run: RunDto; isLive: boolean }) {
  return (
    <header className="flex flex-col gap-1">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Run</h1>
        <code className="shrink-0 text-xs text-muted-foreground">{run.id.slice(0, 8)}</code>
        <span className="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground">{run.state}</span>
        {isLive ? (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />
            Live
          </span>
        ) : null}
      </div>
      <p className="text-sm text-muted-foreground">Created {run.createdAt.toLocaleString()}</p>
    </header>
  );
}

/** The materialized steps of a run, in definition order, each with its live status.
 * Re-rendered in place on every silent poll — no spinner, no layout shift. */
function RunSteps({ steps }: { steps: RunStepDto[] }) {
  return (
    <ol className="flex flex-col gap-2">
      {steps.map(step => (
        <li key={step.id} className="flex items-center justify-between gap-3 rounded-xl border border-border px-4 py-3">
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium">{step.name}</span>
            <code className="shrink-0 text-xs text-muted-foreground">{step.executor}</code>
          </div>
          <span className={`shrink-0 text-xs font-medium ${STEP_TONE[step.status]}`}>{step.status}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * A single run's live detail: its state and step-by-step progression. Polls
 * `run.get` on an interval that stops once the run is terminal.
 *
 * UX invariant: the spinner shows ONLY on the very first load (`isPending`). Every
 * subsequent background refetch is silent — React Query keeps the last data, so the
 * timeline stays rendered and updates in place. We deliberately never gate on
 * `isFetching` (that would flash a blocking spinner on each poll).
 */
export function RunDetail({ workspaceId, runId }: { workspaceId: string; runId: string }) {
  const query = trpc.run.get.useQuery(
    { workspaceId, runId },
    {
      // retry:false — a bad/cross-tenant runId is a permanent NOT_FOUND, not transient.
      retry: false,
      // Stop polling once the run reaches a terminal state; keep polling otherwise.
      refetchInterval: q => {
        const state = q.state.data?.run.state;
        return state !== undefined && TERMINAL_RUN_STATES.has(state) ? false : POLL_MS;
      },
    },
  );

  if (query.isPending) {
    return <span className="size-5 animate-spin rounded-full border-2 border-muted border-t-foreground" />;
  }

  if (query.isError) {
    return <EmptyState title="Run not found" body="This run doesn't exist, or you don't have access to it." />;
  }

  const { run, steps } = query.data;
  const isLive = !TERMINAL_RUN_STATES.has(run.state);

  return (
    <div className="flex flex-col gap-6">
      <RunHeader run={run} isLive={isLive} />
      {steps.length > 0 ? (
        <RunSteps steps={steps} />
      ) : (
        <EmptyState title="No steps" body="This run has no materialized steps." />
      )}
    </div>
  );
}
