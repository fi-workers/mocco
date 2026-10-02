// One changeset in an environment's history (#141): its diff and state, and — while it
// waits for approval — approve/reject for eligible voters (bound to the content hash
// they are looking at) and withdraw/rebase for its proposer.
import { ApprovalDecisions } from '@mocco/common/governance';

import { Ago, errorMessage, StatusBadge, Tones } from '@frontend/components/notifications/notification-ui';
import { describeApprovalPolicy } from '@frontend/components/ota/policy-text';
import { Button } from '@frontend/components/ui/button';
import { useSession } from '@frontend/lib/auth-client';
import { trpc } from '@frontend/lib/trpc';

import type { Tone } from '@frontend/components/notifications/notification-ui';
import type { ChangeDiffEntry, ChangesetDto, ChangesetState } from '@mocco/common/flags';

const fieldLabels: Record<string, string> = {
  enabled: 'on',
  killed: 'killed',
  defaultVariant: 'default variant',
  offVariant: 'off variant',
  rules: 'rules',
  rollout: 'rollout',
  includedKeys: 'included keys',
  excludedKeys: 'excluded keys',
};

const isRollout = (value: unknown[]): value is { variant: string; weight: number }[] =>
  value.every(entry => typeof entry === 'object' && entry !== null && 'variant' in entry && 'weight' in entry);

/** The noun a list field counts: rules, keys or groups. */
const listNouns: Record<string, [string, string]> = {
  rules: ['rule', 'rules'],
  includedKeys: ['key', 'keys'],
  excludedKeys: ['key', 'keys'],
};

/** A diff value in one line: a rollout as its shares, other lists as a count. */
function shortValue(field: string, value: unknown, subject: ChangeDiffEntry['subject']): string {
  if (Array.isArray(value)) {
    if (field === 'rollout' && isRollout(value)) {
      return value.map(entry => `${entry.variant} ${entry.weight}`).join(' · ');
    }
    const [one, many] =
      subject === 'segment' && field === 'rules' ? ['group', 'groups'] : (listNouns[field] ?? ['item', 'items']);
    return `${value.length} ${value.length === 1 ? one : many}`;
  }
  if (field === 'rollout' && value === null) {
    return 'none';
  }
  return typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
}

export function describeDiff(entry: ChangeDiffEntry): string {
  const field = fieldLabels[entry.field] ?? entry.field;
  const subject = entry.subject === 'segment' ? `segment ${entry.key}` : entry.key;
  const show = (value: unknown) => shortValue(entry.field, value, entry.subject);
  if (entry.before === null) {
    return `${subject}: ${field} = ${show(entry.after)}`;
  }
  return `${subject}: ${field} ${show(entry.before)} → ${show(entry.after)}`;
}

const stateBadges: Record<ChangesetState, { label: string; tone: Tone }> = {
  pending: { label: 'Waiting for approval', tone: Tones.warn },
  applied: { label: 'Applied', tone: Tones.ok },
  rejected: { label: 'Rejected', tone: Tones.danger },
  conflicted: { label: 'Conflicted', tone: Tones.danger },
  superseded: { label: 'Superseded', tone: Tones.neutral },
  withdrawn: { label: 'Withdrawn', tone: Tones.neutral },
  expired: { label: 'Expired', tone: Tones.neutral },
};

interface Props {
  workspaceId: string;
  projectId: string;
  changeset: ChangesetDto;
}

function PendingActions({ workspaceId, projectId, changeset }: Props) {
  const utils = trpc.useUtils();
  const { data: session } = useSession();
  const myUserId = session?.user.id ?? null;
  const isMine = myUserId !== null && changeset.proposedByUserId === myUserId;
  // A commit's author proposed it too when someone else pushed: they can't decide either.
  const isCoProposer = myUserId !== null && changeset.coProposerUserIds.includes(myUserId);
  const refresh = async () => {
    await Promise.all([
      utils.flags.timeline.invalidate(),
      utils.flags.list.invalidate(),
      utils.flags.environments.invalidate(),
      utils.flags.segments.invalidate(),
    ]);
  };
  const vote = trpc.flags.voteChangeset.useMutation({ onSuccess: refresh });
  const withdraw = trpc.flags.withdrawChangeset.useMutation({ onSuccess: refresh });
  const rebase = trpc.flags.rebaseChangeset.useMutation({ onSuccess: refresh });
  const error = vote.error ?? withdraw.error ?? rebase.error;
  const input = { workspaceId, projectId, changesetId: changeset.id };
  const canDecide = !(changeset.requirements?.prevent_self === true && (isMine || isCoProposer));

  return (
    <div className="flex flex-col gap-1.5">
      {changeset.requirements === null ? null : (
        <p className="text-xs text-muted-foreground">
          Needs {describeApprovalPolicy(changeset.requirements)} · proposed against v{changeset.baseVersion} · hash{' '}
          <span className="font-mono">{changeset.contentHash.slice(0, 12)}</span>
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {changeset.state === 'pending' && canDecide ? (
          <>
            <Button
              size="sm"
              pending={vote.isPending}
              onClick={() => {
                vote.mutate({ ...input, contentHash: changeset.contentHash, decision: ApprovalDecisions.approve });
              }}>
              Approve
            </Button>
            <Button
              variant="outline"
              size="sm"
              pending={vote.isPending}
              onClick={() => {
                vote.mutate({ ...input, contentHash: changeset.contentHash, decision: ApprovalDecisions.reject });
              }}>
              Reject
            </Button>
          </>
        ) : null}
        {changeset.state === 'pending' && !canDecide ? (
          <span className="text-xs text-muted-foreground">
            You proposed this change, so someone else has to decide.
          </span>
        ) : null}
        {isMine ? (
          <>
            <Button
              variant="outline"
              size="sm"
              pending={rebase.isPending}
              onClick={() => {
                rebase.mutate(input);
              }}>
              Rebase on the current version
            </Button>
            {changeset.state === 'pending' ? (
              <Button
                variant="ghost"
                size="sm"
                pending={withdraw.isPending}
                onClick={() => {
                  withdraw.mutate(input);
                }}>
                Withdraw
              </Button>
            ) : null}
          </>
        ) : null}
      </div>
      {error ? <p className="text-xs text-destructive">{errorMessage(error)}</p> : null}
    </div>
  );
}

export default function ChangesetRow({ workspaceId, projectId, changeset }: Props) {
  const badge = stateBadges[changeset.state];
  const isOpen = changeset.state === 'pending' || changeset.state === 'conflicted';
  return (
    <li
      aria-label={`Changeset ${changeset.id}`}
      className={`flex flex-col gap-1.5 rounded-lg border px-3 py-2 text-sm ${
        changeset.state === 'pending' ? 'border-amber-600/30 bg-amber-500/5' : 'border-border'
      }`}>
      <div className="flex flex-wrap items-center gap-2">
        {changeset.appliedVersion === null ? null : (
          <StatusBadge tone={Tones.ok}>v{changeset.appliedVersion}</StatusBadge>
        )}
        {changeset.state === 'applied' ? null : <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>}
        <span className="text-xs text-muted-foreground">
          <Ago date={changeset.createdAt} />
        </span>
        {changeset.commitSha === null ? null : (
          <StatusBadge tone={Tones.neutral}>From commit {changeset.commitSha.slice(0, 7)}</StatusBadge>
        )}
        {changeset.reason === null ? null : <span className="text-xs text-muted-foreground">· {changeset.reason}</span>}
      </div>
      <ul className="font-mono text-xs">
        {changeset.diff.map(entry => (
          <li key={`${entry.subject}:${entry.key}:${entry.field}`}>{describeDiff(entry)}</li>
        ))}
      </ul>
      {isOpen ? <PendingActions workspaceId={workspaceId} projectId={projectId} changeset={changeset} /> : null}
    </li>
  );
}
