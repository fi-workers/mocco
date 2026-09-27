import { ApprovalDecisions, ApprovalKinds } from '@mocco/common/governance';
import { useState } from 'react';

import {
  Ago,
  errorMessage,
  inputClass,
  labelClass,
  StatusBadge,
  Tones,
} from '@frontend/components/notifications/notification-ui';
import { describeApprovalPolicy, diffRules, parsePinnedAction, parseRules } from '@frontend/components/ota/policy-text';
import { Button } from '@frontend/components/ui/button';
import { trpc } from '@frontend/lib/trpc';

import type { ApprovalDecision, ApprovalRequestDto, ApprovalVoteDto } from '@mocco/common/governance';
import type { VersionPolicyChangeDto, VersionPolicyRules } from '@mocco/common/ota';

interface Props {
  workspaceId: string;
  projectId: string;
  appId: string;
  /** Pending requests for this app's policy, newest first. */
  requests: readonly ApprovalRequestDto[];
  current: VersionPolicyRules | null;
  changes: readonly VersionPolicyChangeDto[];
  nameOf: (userId: string | null) => string;
  myUserId: string | undefined;
}

/** What the request would change (a pre-approval) or did change (a post-hoc review). */
function changeLines(
  request: ApprovalRequestDto,
  current: VersionPolicyRules | null,
  changes: readonly VersionPolicyChangeDto[],
): string[] {
  const pinned = parsePinnedAction(request.action);
  if (request.kind === ApprovalKinds.review) {
    const applied = changes.find(change => change.id === pinned.changeId);
    const after = parseRules(applied?.after);
    return after === null ? [] : diffRules(parseRules(applied?.before), after);
  }
  return pinned.rules === null ? [] : diffRules(current, pinned.rules);
}

interface CardProps extends Omit<Props, 'requests'> {
  request: ApprovalRequestDto;
}

/** Approve / reject with an optional reason. Hidden once you voted, and for the requester
 * when the policy bars self-approval (the server refuses their vote either way). */
function VoteControls({
  workspaceId,
  projectId,
  appId,
  request,
  votes,
  myUserId,
}: CardProps & { votes: readonly ApprovalVoteDto[] }) {
  const utils = trpc.useUtils();
  const [reason, setReason] = useState('');
  const vote = trpc.approval.vote.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.approval.list.invalidate({ workspaceId }),
        utils.approval.get.invalidate({ workspaceId, requestId: request.id }),
        utils.ota.versionPolicy.get.invalidate({ workspaceId, projectId, appId }),
        utils.ota.versionPolicy.history.invalidate({ workspaceId, projectId, appId }),
      ]);
    },
  });
  if (myUserId === undefined) {
    return null;
  }
  if (votes.some(entry => entry.userId === myUserId)) {
    return <p className="text-xs text-muted-foreground">You voted on this request.</p>;
  }
  if (request.requirements.prevent_self && request.requestedByUserId === myUserId) {
    return (
      <p className="text-xs text-muted-foreground">
        {request.kind === ApprovalKinds.review
          ? 'You made this change, so someone else has to review it.'
          : 'You requested this change, so someone else has to decide. Submitting a new change replaces it.'}
      </p>
    );
  }
  // eslint-disable-next-line sonarjs/null-dereference -- reason is a useState<string>, never null
  const trimmedReason = reason.trim();
  const cast = (decision: ApprovalDecision) => {
    vote.mutate({
      workspaceId,
      requestId: request.id,
      decision,
      ...(trimmedReason !== '' && { reason: trimmedReason }),
    });
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <label className={`${labelClass} min-w-48 flex-1`}>
          {request.requirements.reason_required ? 'Reason (required)' : 'Reason (optional)'}
          <input
            maxLength={500}
            value={reason}
            onChange={event => {
              setReason(event.target.value);
            }}
            className={inputClass}
          />
        </label>
        <Button
          className="text-sm"
          pending={vote.isPending && vote.variables.decision === ApprovalDecisions.approve}
          onClick={() => {
            cast(ApprovalDecisions.approve);
          }}>
          {request.kind === ApprovalKinds.review ? 'Mark reviewed' : 'Approve'}
        </Button>
        <Button
          variant="outline"
          className="text-sm"
          pending={vote.isPending && vote.variables.decision === ApprovalDecisions.reject}
          onClick={() => {
            cast(ApprovalDecisions.reject);
          }}>
          Reject
        </Button>
      </div>
      {vote.error ? <p className="text-sm text-destructive">{errorMessage(vote.error)}</p> : null}
    </div>
  );
}

function RequestCard(props: CardProps) {
  const { workspaceId, request, current, changes, nameOf } = props;
  const detailQuery = trpc.approval.get.useQuery({ workspaceId, requestId: request.id });
  const pinned = parsePinnedAction(request.action);
  const lines = changeLines(request, current, changes);
  const votes = detailQuery.data?.votes ?? [];
  const isReview = request.kind === ApprovalKinds.review;

  return (
    <li className="flex flex-col gap-3 rounded-xl border border-border p-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <StatusBadge tone={isReview ? Tones.neutral : Tones.warn}>
          {isReview ? 'Post-hoc review' : 'Waiting for approval'}
        </StatusBadge>
        <span className="text-muted-foreground">
          {nameOf(request.requestedByUserId)} · <Ago date={request.createdAt} />
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        {isReview ? 'Applied at once because it relaxes the policy. ' : ''}
        Needs {describeApprovalPolicy(request.requirements)}.
      </p>
      {lines.length > 0 ? (
        <ul className="flex flex-col gap-0.5 rounded-lg bg-muted/40 px-3 py-2 font-mono text-xs">
          {lines.map(line => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      {pinned.reason ? <p className="text-sm">“{pinned.reason}”</p> : null}
      {pinned.isStoreLiveAttested ? (
        <p className="text-xs text-muted-foreground">The requester confirmed the version is live on the store.</p>
      ) : null}
      {votes.length > 0 ? (
        <ul className="flex flex-col gap-1 text-xs">
          {votes.map(entry => (
            <li key={entry.id} className="flex flex-wrap items-center gap-2">
              <StatusBadge tone={entry.decision === ApprovalDecisions.approve ? Tones.ok : Tones.danger}>
                {entry.decision === ApprovalDecisions.approve ? 'Approved' : 'Rejected'}
              </StatusBadge>
              <span>{nameOf(entry.userId)}</span>
              {entry.reason ? <span className="text-muted-foreground">— {entry.reason}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <VoteControls {...props} votes={votes} />
    </li>
  );
}

/** The app's open requests: pre-approvals waiting to apply, and post-hoc reviews of
 * relaxing changes that already applied. Each shows its change, votes and vote controls. */
export default function VersionPolicyApprovals({
  workspaceId,
  projectId,
  appId,
  requests,
  current,
  changes,
  nameOf,
  myUserId,
}: Props) {
  if (requests.length === 0) {
    return null;
  }
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-medium">Open requests</h3>
        <p className="text-xs text-muted-foreground">
          A newer change request replaces an older one that is still waiting.
        </p>
      </div>
      <ul className="flex flex-col gap-3">
        {requests.map(request => (
          <RequestCard
            key={request.id}
            workspaceId={workspaceId}
            projectId={projectId}
            appId={appId}
            request={request}
            current={current}
            changes={changes}
            nameOf={nameOf}
            myUserId={myUserId}
          />
        ))}
      </ul>
    </section>
  );
}
