import { ApprovalStates } from '@mocco/common/governance';
import { PolicyDirections } from '@mocco/common/ota';

import { Ago, Spinner, StatusBadge, Tones } from '@frontend/components/notifications/notification-ui';
import { diffRules, directionLabels, parseRules } from '@frontend/components/ota/policy-text';

import type { Tone } from '@frontend/components/notifications/notification-ui';
import type { ApprovalState } from '@mocco/common/governance';
import type { PolicyDirection, VersionPolicyChangeDto } from '@mocco/common/ota';

interface Props {
  changes: readonly VersionPolicyChangeDto[] | undefined;
  /** The post-hoc review state of each relaxing change, by change id. */
  reviewStates: ReadonlyMap<string, ApprovalState>;
  nameOf: (userId: string | null) => string;
}

const directionTones: Record<PolicyDirection, Tone> = {
  [PolicyDirections.tighten]: Tones.warn,
  [PolicyDirections.relax]: Tones.ok,
  [PolicyDirections.none]: Tones.neutral,
};

/** How a relaxing change's post-hoc review stands. An open review is an evidence gap
 * the team can see: the change applied, nobody has signed off yet. */
function ReviewBadge({ state }: { state: ApprovalState | undefined }) {
  if (state === undefined) {
    return null;
  }
  if (state === ApprovalStates.pending) {
    return <StatusBadge tone={Tones.warn}>Unreviewed</StatusBadge>;
  }
  if (state === ApprovalStates.approved) {
    return <StatusBadge tone={Tones.ok}>Reviewed</StatusBadge>;
  }
  return <StatusBadge tone={Tones.danger}>Review {state}</StatusBadge>;
}

/** Every applied change to the app's policy, newest first: what changed, its direction,
 * who made it and why, and whether an approval applied it. */
export default function VersionPolicyHistory({ changes, reviewStates, nameOf }: Props) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-medium">History</h3>
        <p className="text-xs text-muted-foreground">Applied changes, newest first. Each one is in the audit log.</p>
      </div>
      {changes === undefined ? <Spinner /> : null}
      {changes?.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          No changes yet.
        </p>
      ) : null}
      <ol className="flex flex-col gap-2">
        {changes?.map(change => {
          const after = parseRules(change.after);
          const lines = after === null ? [] : diffRules(parseRules(change.before), after);
          return (
            <li key={change.id} className="flex flex-col gap-2 rounded-xl border border-border px-4 py-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <StatusBadge tone={directionTones[change.direction]}>{directionLabels[change.direction]}</StatusBadge>
                <ReviewBadge state={reviewStates.get(change.id)} />
                <span className="text-muted-foreground">
                  {nameOf(change.actorUserId)} · <Ago date={change.createdAt} />
                  {change.approvalRequestId === null ? null : ' · applied on approval'}
                </span>
              </div>
              {lines.length > 0 ? (
                <ul className="flex flex-col gap-0.5 font-mono text-xs">
                  {lines.map(line => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">Prompt copy only.</p>
              )}
              {change.reason ? <p className="text-sm">“{change.reason}”</p> : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
