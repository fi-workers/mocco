import { RunStates, RunStepStatuses } from '@mocco/common/execution';
import { ResumeDecisions } from '@mocco/common/governance';
import { useState } from 'react';

import { Button } from '@frontend/components/ui/button';
import { useSession } from '@frontend/lib/auth-client';
import { fireAndForget } from '@frontend/lib/fire-and-forget';
import { trpc } from '@frontend/lib/trpc';

import type { RunDto, RunState, RunStepDto, RunStepStatus } from '@mocco/common/execution';
import type { ResumeDecision, ResumeDto, RunGateDto } from '@mocco/common/governance';

/** Poll cadence for the live timeline. Fast enough to feel live, slow enough to be cheap. */
const POLL_MS = 1500;

/** States from which the run no longer changes — polling stops once reached. A gate
 * `rejected` run is terminal too; `awaiting_gate` is NOT (it awaits a vote). */
const TERMINAL_RUN_STATES = new Set<RunState>([
  RunStates.succeeded,
  RunStates.failed,
  RunStates.canceled,
  RunStates.rejected,
]);

const inputClass =
  'w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:border-ring';

/** Shared Tailwind tone tokens — a muted default and a satisfied/success green. */
const TONE_MUTED = 'text-muted-foreground';
const TONE_OK = 'text-emerald-600 dark:text-emerald-400';

/** Tailwind tone per step status — a small visual cue on the timeline dot/label. */
const STEP_TONE: Record<RunStepStatus, string> = {
  [RunStepStatuses.pending]: TONE_MUTED,
  [RunStepStatuses.dispatched]: TONE_MUTED,
  [RunStepStatuses.running]: 'text-foreground',
  [RunStepStatuses.succeeded]: TONE_OK,
  [RunStepStatuses.failed]: 'text-destructive',
  [RunStepStatuses.skipped]: TONE_MUTED,
  [RunStepStatuses.canceled]: TONE_MUTED,
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

/** Tone per gate state — a small visual cue on the gate card badge. */
const GATE_TONE: Record<RunGateDto['state'], string> = {
  pending: 'text-foreground',
  resumed: TONE_OK,
  rejected: 'text-destructive',
  expired: TONE_MUTED,
};

/** Why the viewer can't vote (best-effort, client-side), or undefined if they can. */
function blockedVoteHint(hasVoted: boolean, isSelfBlocked: boolean): string | undefined {
  if (hasVoted) {
    return 'You have already voted on this gate.';
  }
  if (isSelfBlocked) {
    return "You triggered this run and can't approve your own gate.";
  }
  return undefined;
}

/**
 * A single gate on the run: its requirements and per-role progress, plus — when the
 * run is paused here — Approve/Reject controls. Eligibility is best-effort from the
 * data on hand (the triggerer under `prevent_self`, an already-cast vote); role
 * membership and `reason_required` are enforced server-side (surfaced as an error).
 */
function GateCard({
  workspaceId,
  runId,
  run,
  gate,
  resumes,
  viewerUserId,
}: {
  workspaceId: string;
  runId: string;
  run: RunDto;
  gate: RunGateDto;
  resumes: ResumeDto[];
  viewerUserId: string | undefined;
}) {
  const utils = trpc.useUtils();
  const { mutateAsync: resumeGate, isPending, error } = trpc.run.resumeGate.useMutation();
  const [reason, setReason] = useState('');

  const gateResumes = resumes.filter(resume => resume.runGateId === gate.id);
  const approvals = gateResumes.filter(resume => resume.decision === ResumeDecisions.resume);
  const perRole = gate.requirements.resume.map(requirement => ({
    role: requirement.role,
    count: requirement.count,
    have: approvals.filter(resume => resume.roleName === requirement.role).length,
  }));

  const isCurrent = run.state === RunStates.awaitingGate && run.currentIndex === gate.itemIndex;
  const hasVoted = viewerUserId !== undefined && gateResumes.some(resume => resume.userId === viewerUserId);
  const isSelfBlocked =
    gate.requirements.prevent_self && viewerUserId !== undefined && run.triggeredByUserId === viewerUserId;
  // reason is a useState<string> (never null); the trim is safe.
  // eslint-disable-next-line sonarjs/null-dereference
  const isReasonMissing = gate.requirements.reason_required && reason.trim() === '';

  const blockedHint = blockedVoteHint(hasVoted, isSelfBlocked);
  const areControlsDisabled = isPending || hasVoted || isSelfBlocked;

  const vote = async (decision: ResumeDecision): Promise<void> => {
    await resumeGate({
      workspaceId,
      runId,
      gateItemIndex: gate.itemIndex,
      decision,
      reason: reason.trim() === '' ? undefined : reason.trim(),
    });
    setReason('');
    await utils.run.get.invalidate({ workspaceId, runId });
  };

  return (
    <li className="flex flex-col gap-3 rounded-xl border border-border px-4 py-4">
      <div className="flex items-center gap-3">
        <span className="text-sm font-semibold">Gate: {gate.name}</span>
        <span className={`rounded-md border border-border px-2 py-0.5 text-xs font-medium ${GATE_TONE[gate.state]}`}>
          {gate.state}
        </span>
      </div>

      <ul className="flex flex-col gap-1">
        {perRole.map(requirement => (
          <li key={requirement.role} className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">{requirement.role}</span>
            <span className={requirement.have >= requirement.count ? TONE_OK : ''}>
              {requirement.have} / {requirement.count} approvals
            </span>
          </li>
        ))}
      </ul>

      {isCurrent ? (
        <div className="flex flex-col gap-2">
          <textarea
            aria-label={`Reason for ${gate.name}`}
            className={inputClass}
            rows={2}
            value={reason}
            placeholder={gate.requirements.reason_required ? 'Reason (required)' : 'Reason (optional)'}
            disabled={areControlsDisabled}
            onChange={event => {
              setReason(event.target.value);
            }}
          />
          <div className="flex items-center gap-2">
            <Button
              pending={isPending}
              disabled={areControlsDisabled || isReasonMissing}
              onClick={() => {
                fireAndForget(vote(ResumeDecisions.resume));
              }}>
              Approve
            </Button>
            <Button
              variant="outline"
              className="text-destructive"
              disabled={areControlsDisabled || isReasonMissing}
              onClick={() => {
                fireAndForget(vote(ResumeDecisions.reject));
              }}>
              Reject
            </Button>
            {blockedHint ? <span className="text-xs text-muted-foreground">{blockedHint}</span> : null}
          </div>
          {error ? <p className="text-xs text-destructive">{error.message}</p> : null}
        </div>
      ) : null}
    </li>
  );
}

/** The run's gates, in item order. Rendered below the steps — a gate the run is
 * paused at shows its resume controls. */
function RunGates({
  workspaceId,
  runId,
  run,
  gates,
  resumes,
  viewerUserId,
}: {
  workspaceId: string;
  runId: string;
  run: RunDto;
  gates: RunGateDto[];
  resumes: ResumeDto[];
  viewerUserId: string | undefined;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium">Gates</h2>
      <ul className="flex flex-col gap-2">
        {gates.map(gate => (
          <GateCard
            key={gate.id}
            workspaceId={workspaceId}
            runId={runId}
            run={run}
            gate={gate}
            resumes={resumes}
            viewerUserId={viewerUserId}
          />
        ))}
      </ul>
    </section>
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
  const { data: session } = useSession();
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

  const { run, steps, gates, resumes } = query.data;
  const isLive = !TERMINAL_RUN_STATES.has(run.state);

  return (
    <div className="flex flex-col gap-6">
      <RunHeader run={run} isLive={isLive} />
      {steps.length > 0 ? (
        <RunSteps steps={steps} />
      ) : (
        <EmptyState title="No steps" body="This run has no materialized steps." />
      )}
      {gates.length > 0 ? (
        <RunGates
          workspaceId={workspaceId}
          runId={runId}
          run={run}
          gates={gates}
          resumes={resumes}
          viewerUserId={session?.user.id}
        />
      ) : null}
    </div>
  );
}
