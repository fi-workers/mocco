import { trpc } from '@frontend/lib/trpc';

import type { RunDto, RunStepDto } from '@mocco/common/execution';

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <section className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-6 py-16 text-center">
      <h2 className="text-sm font-medium">{title}</h2>
      <p className="max-w-sm text-sm text-muted-foreground">{body}</p>
    </section>
  );
}

/** The run's identity: a short id and its current state. The timeline (live
 * step-by-step progression) lands in PR3 — here the state is a static snapshot. */
function RunHeader({ run }: { run: RunDto }) {
  return (
    <header className="flex flex-col gap-1">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Run</h1>
        <code className="shrink-0 text-xs text-muted-foreground">{run.id.slice(0, 8)}</code>
        <span className="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground">{run.state}</span>
      </div>
      <p className="text-sm text-muted-foreground">Created {run.createdAt.toLocaleString()}</p>
    </header>
  );
}

/** The materialized steps of a run, in definition order, each with its status.
 * PR2 shows them all `pending` (nothing dispatches yet — the loop is PR3). */
function RunSteps({ steps }: { steps: RunStepDto[] }) {
  return (
    <ol className="flex flex-col gap-2">
      {steps.map(step => (
        <li key={step.id} className="flex items-center justify-between gap-3 rounded-xl border border-border px-4 py-3">
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium">{step.name}</span>
            <code className="shrink-0 text-xs text-muted-foreground">{step.executor}</code>
          </div>
          <span className="shrink-0 text-xs text-muted-foreground">{step.status}</span>
        </li>
      ))}
    </ol>
  );
}

/** A single run's detail: its state and its materialized steps. Read-only — a
 * pure DB read (`run.get`). No live polling yet; the live timeline is PR3. */
export function RunDetail({ workspaceId, runId }: { workspaceId: string; runId: string }) {
  // retry:false — a bad/cross-tenant runId is a permanent NOT_FOUND, not transient.
  const query = trpc.run.get.useQuery({ workspaceId, runId }, { retry: false });

  if (query.isPending) {
    return <span className="size-5 animate-spin rounded-full border-2 border-muted border-t-foreground" />;
  }

  if (query.isError) {
    return <EmptyState title="Run not found" body="This run doesn't exist, or you don't have access to it." />;
  }

  const { run, steps } = query.data;

  return (
    <div className="flex flex-col gap-6">
      <RunHeader run={run} />
      {steps.length > 0 ? (
        <RunSteps steps={steps} />
      ) : (
        <EmptyState title="No steps" body="This run has no materialized steps." />
      )}
    </div>
  );
}
