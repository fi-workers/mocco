// Protecting a subject with a gate (OTA channels, flag environments): the editor for its
// gate, and the pending requests to change it with approve/reject for eligible voters.
import { ApprovalDecisions, ApprovalStates } from '@mocco/common/governance';
import Link from 'next/link';
import { useState } from 'react';

import {
  Ago,
  errorMessage,
  inputClass,
  labelClass,
  StatusBadge,
  Tones,
} from '@frontend/components/notifications/notification-ui';
import { describeApprovalPolicy } from '@frontend/components/ota/policy-text';
import { Button } from '@frontend/components/ui/button';
import { useSession } from '@frontend/lib/auth-client';
import { Routes } from '@frontend/lib/routes';
import { trpc } from '@frontend/lib/trpc';

import type { GateRequirements } from '@mocco/common/governance';

export function GateEditor({
  workspaceId,
  current,
  subjectNoun,
  onSubmit,
  isPending,
}: {
  workspaceId: string;
  /** The subject's gate now; null when unprotected. */
  current: GateRequirements | null;
  /** What is protected, for the button labels ("channel", "environment"). */
  subjectNoun: string;
  onSubmit: (gate: GateRequirements | null) => void;
  isPending: boolean;
}) {
  const rolesQuery = trpc.role.list.useQuery({ workspaceId });
  const roles = rolesQuery.data?.roles ?? [];
  const slot = current?.resume[0];
  const [role, setRole] = useState(slot?.role ?? '');
  const [count, setCount] = useState(slot?.count ?? 1);
  const [isSelfPrevented, setIsSelfPrevented] = useState(current?.prevent_self ?? true);
  const chosenRole = role === '' ? (roles[0]?.name ?? '') : role;

  if (rolesQuery.isSuccess && roles.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        Approvals count per role.{' '}
        <Link href={Routes.workspaceAccess(workspaceId)} className="underline underline-offset-2">
          Create one on the Access page
        </Link>{' '}
        first.
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-end gap-2 rounded-lg bg-muted/40 p-3">
      <label className={labelClass}>
        Approvers&apos; role
        <select
          value={chosenRole}
          onChange={event => {
            setRole(event.target.value);
          }}
          className={inputClass}>
          {roles.map(entry => (
            <option key={entry.id} value={entry.name}>
              {entry.name}
            </option>
          ))}
        </select>
      </label>
      <label className={labelClass}>
        Approvals
        <input
          type="number"
          min={1}
          max={20}
          value={count}
          onChange={event => {
            setCount(Math.max(1, Math.trunc(Number(event.target.value)) || 1));
          }}
          className={`${inputClass} w-20`}
        />
      </label>
      <label className="flex items-center gap-2 pb-1.5 text-sm">
        <input
          type="checkbox"
          checked={isSelfPrevented}
          onChange={event => {
            setIsSelfPrevented(event.target.checked);
          }}
        />
        Not the requester
      </label>
      <Button
        className="text-sm"
        pending={isPending}
        disabled={chosenRole === ''}
        onClick={() => {
          onSubmit({ resume: [{ role: chosenRole, count }], prevent_self: isSelfPrevented, reason_required: false });
        }}>
        {current === null ? `Protect ${subjectNoun}` : 'Change protection'}
      </Button>
      {current === null ? null : (
        <Button
          variant="outline"
          className="text-sm"
          pending={isPending}
          onClick={() => {
            onSubmit(null);
          }}>
          Remove protection
        </Button>
      )}
    </div>
  );
}

/** Pending requests to change a subject's gate, with approve and reject for eligible voters. */
export function PendingGateRequests({
  workspaceId,
  subjectType,
  subjectId,
  gateOf,
  onDecided,
}: {
  workspaceId: string;
  subjectType: string;
  subjectId: string;
  /** The gate a request's pinned action would set (null: remove protection). */
  gateOf: (action: unknown) => GateRequirements | null | undefined;
  onDecided: () => Promise<void>;
}) {
  const utils = trpc.useUtils();
  const requestsQuery = trpc.approval.list.useQuery({
    workspaceId,
    subjectType,
    subjectId,
    state: ApprovalStates.pending,
  });
  const vote = trpc.approval.vote.useMutation({
    onSuccess: async () => {
      await Promise.all([utils.approval.list.invalidate({ workspaceId }), onDecided()]);
    },
  });
  const { data: session } = useSession();
  const myUserId = session?.user.id ?? null;
  const requests = requestsQuery.data?.requests ?? [];
  if (requests.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-col gap-2">
      {requests.map(request => {
        const target = gateOf(request.action) ?? null;
        return (
          <div
            key={request.id}
            className="flex flex-col gap-2 rounded-lg border border-amber-600/30 bg-amber-500/5 p-3">
            <p className="text-sm">
              <StatusBadge tone={Tones.warn}>Waiting for approval</StatusBadge>{' '}
              <span className="text-muted-foreground">
                → {target === null ? 'no protection' : describeApprovalPolicy(target)} · requested{' '}
                <Ago date={request.createdAt} />
              </span>
            </p>
            <p className="text-xs text-muted-foreground">Needs {describeApprovalPolicy(request.requirements)}.</p>
            {request.requirements.prevent_self && myUserId !== null && request.requestedByUserId === myUserId ? (
              <p className="text-xs text-muted-foreground">You requested this change, so someone else has to decide.</p>
            ) : (
              <div className="flex gap-2">
                <Button
                  size="sm"
                  pending={vote.isPending}
                  onClick={() => {
                    vote.mutate({ workspaceId, requestId: request.id, decision: ApprovalDecisions.approve });
                  }}>
                  Approve
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  pending={vote.isPending}
                  onClick={() => {
                    vote.mutate({ workspaceId, requestId: request.id, decision: ApprovalDecisions.reject });
                  }}>
                  Reject
                </Button>
              </div>
            )}
            {vote.error ? <p className="text-sm text-destructive">{errorMessage(vote.error)}</p> : null}
          </div>
        );
      })}
    </div>
  );
}
