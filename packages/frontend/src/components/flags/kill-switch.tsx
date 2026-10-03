// A flag's kill switch in one environment (#142): kill it now with a reason (never waits
// for approval), or — once killed — restore it, which is a normal change (gated on a
// protected environment).
import { FlagApprovalSubjects } from '@mocco/common/flags';
import { ApprovalDecisions, ApprovalStates } from '@mocco/common/governance';
import { useState } from 'react';
import { z } from 'zod';

import {
  Ago,
  errorMessage,
  inputClass,
  labelClass,
  Notice,
  StatusBadge,
  Tones,
} from '@frontend/components/notifications/notification-ui';
import { describeApprovalPolicy } from '@frontend/components/ota/policy-text';
import { Button } from '@frontend/components/ui/button';
import { useSession } from '@frontend/lib/auth-client';
import { trpc } from '@frontend/lib/trpc';

import type { FlagConfigDto, FlagEnvironmentDto } from '@mocco/common/flags';

/** What a kill review pins. */
const killActionSchema = z.object({ environmentId: z.uuid(), flagKey: z.string(), reason: z.string() });

/** Post-hoc reviews of kills of this flag here (protected environments only). */
function KillReviews({ workspaceId, flagKey, environment }: Omit<Props, 'projectId' | 'config'>) {
  const utils = trpc.useUtils();
  const { data: session } = useSession();
  const requestsQuery = trpc.approval.list.useQuery({
    workspaceId,
    subjectType: FlagApprovalSubjects.kill,
    state: ApprovalStates.pending,
  });
  const vote = trpc.approval.vote.useMutation({
    onSuccess: async () => {
      await utils.approval.list.invalidate({ workspaceId });
    },
  });
  const reviews = (requestsQuery.data?.requests ?? []).filter(request => {
    const action = killActionSchema.safeParse(request.action);
    return action.success && action.data.environmentId === environment.id && action.data.flagKey === flagKey;
  });
  if (reviews.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-col gap-2">
      {reviews.map(review => {
        const myUserId = session?.user.id ?? null;
        const isMine = myUserId !== null && review.requestedByUserId === myUserId;
        return (
          <div
            key={review.id}
            className="flex flex-col gap-1.5 rounded-lg border border-amber-600/30 bg-amber-500/5 p-3">
            <p className="text-sm">
              <StatusBadge tone={Tones.warn}>Kill to review</StatusBadge>{' '}
              <span className="text-xs text-muted-foreground">
                killed <Ago date={review.createdAt} /> · needs {describeApprovalPolicy(review.requirements)}
              </span>
            </p>
            {review.requirements.prevent_self && isMine ? (
              <p className="text-xs text-muted-foreground">You killed it, so someone else reviews it.</p>
            ) : (
              <div className="flex gap-2">
                <Button
                  size="sm"
                  pending={vote.isPending}
                  onClick={() => {
                    vote.mutate({ workspaceId, requestId: review.id, decision: ApprovalDecisions.approve });
                  }}>
                  Mark reviewed
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  pending={vote.isPending}
                  onClick={() => {
                    vote.mutate({ workspaceId, requestId: review.id, decision: ApprovalDecisions.reject });
                  }}>
                  Flag a problem
                </Button>
              </div>
            )}
            {vote.error ? <p className="text-xs text-destructive">{errorMessage(vote.error)}</p> : null}
          </div>
        );
      })}
    </div>
  );
}

interface Props {
  workspaceId: string;
  projectId: string;
  flagKey: string;
  environment: FlagEnvironmentDto;
  config: FlagConfigDto;
}

export default function KillSwitch({ workspaceId, projectId, flagKey, environment, config }: Props) {
  const utils = trpc.useUtils();
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const refresh = async () => {
    await Promise.all([
      utils.flags.list.invalidate(),
      utils.flags.environments.invalidate(),
      utils.flags.timeline.invalidate(),
    ]);
  };
  const kill = trpc.flags.kill.useMutation({
    onSuccess: async () => {
      setReason('');
      await Promise.all([refresh(), utils.approval.list.invalidate({ workspaceId })]);
    },
  });
  const restore = trpc.flags.applyChangeset.useMutation({
    onSuccess: async result => {
      setNotice(result.outcome === 'pending_approval' ? 'The restore was sent for approval.' : null);
      await refresh();
    },
  });
  const error = kill.error ?? restore.error;
  // eslint-disable-next-line sonarjs/null-dereference -- a useState<string>, never null
  const trimmed = reason.trim();

  return (
    <section className="flex flex-col gap-2 rounded-xl border border-destructive/30 p-4">
      <h3 className="text-sm font-medium">Kill switch</h3>
      {config.killed ? (
        <>
          <Notice tone={Tones.danger} title={`Killed in ${environment.name}`}>
            Everyone gets <span className="font-mono">{config.offVariant}</span>, whatever the rules say — even SDKs and
            flagd clients that ignore Mocco&apos;s metadata.
          </Notice>
          <Button
            variant="outline"
            className="w-fit text-sm"
            pending={restore.isPending}
            onClick={() => {
              setNotice(null);
              restore.mutate({
                workspaceId,
                projectId,
                environmentId: environment.id,
                baseVersion: environment.currentVersion,
                ops: [{ op: 'restore', flagKey }],
              });
            }}>
            {environment.changeGate === null ? 'Restore' : 'Propose restore'}
          </Button>
        </>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            Stops the flag at once: everyone gets <span className="font-mono">{config.offVariant}</span>. A kill never
            waits for approval and is always recorded with your reason; restoring it is a normal change.
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <label className={`${labelClass} min-w-64 flex-1`}>
              Reason for the kill
              <input
                value={reason}
                maxLength={500}
                placeholder="Checkout errors spiking"
                className={inputClass}
                onChange={event => {
                  setReason(event.target.value);
                }}
              />
            </label>
            <Button
              variant="destructive"
              className="text-sm"
              pending={kill.isPending}
              disabled={trimmed === ''}
              onClick={() => {
                setNotice(null);
                kill.mutate({ workspaceId, projectId, environmentId: environment.id, flagKey, reason: trimmed });
              }}>
              Kill in {environment.name}
            </Button>
          </div>
        </>
      )}
      <KillReviews workspaceId={workspaceId} flagKey={flagKey} environment={environment} />
      {notice === null ? null : <p className="text-xs text-muted-foreground">{notice}</p>}
      {error ? <p className="text-sm text-destructive">{errorMessage(error)}</p> : null}
    </section>
  );
}
