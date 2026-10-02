// The notification messages for changesets to protected environments (rendered when the
// event is recorded, like OTA promotions). Pure.
import { FlagEventTypes } from '@mocco/common/events';
import { Severities } from '@mocco/common/notification';

import type { ChangeDiffEntry } from '@mocco/common/flags';
import type { NeutralMessage } from '@mocco/common/notification';

/** The changeset events (the kill alert and the stale digest render their own messages). */
export type ChangesetEventType = Exclude<
  (typeof FlagEventTypes)[keyof typeof FlagEventTypes],
  typeof FlagEventTypes.flagKilled | typeof FlagEventTypes.flagStaleDigest
>;

const headlines: Record<ChangesetEventType, { verb: string; severity: NeutralMessage['severity'] }> = {
  [FlagEventTypes.flagChangesetRequested]: { verb: 'Approval needed', severity: Severities.warning },
  [FlagEventTypes.flagChangesetApplied]: { verb: 'Applied', severity: Severities.success },
  [FlagEventTypes.flagChangesetRejected]: { verb: 'Rejected', severity: Severities.error },
};

// eslint-disable-next-line sonarjs/null-dereference -- value is a string, never null
const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

/** `new-checkout, segment staff` — what a changeset touches, briefly. */
export function changesetSubjects(diff: readonly ChangeDiffEntry[]): string {
  const subjects = [...new Set(diff.map(entry => (entry.subject === 'segment' ? `segment ${entry.key}` : entry.key)))];
  return subjects.length > 3
    ? `${subjects.slice(0, 3).join(', ')} and ${subjects.length - 3} more`
    : subjects.join(', ');
}

export function changesetMessage(
  type: ChangesetEventType,
  subject: {
    workspaceId: string;
    projectId: string;
    environment: { id: string; name: string };
    diff: readonly ChangeDiffEntry[];
    requestedBy: string;
    reason: string | null;
  },
  appOrigin: string | undefined,
): NeutralMessage {
  const { verb, severity } = headlines[type];
  const touched = changesetSubjects(subject.diff);
  return {
    title: clip(`${verb}: flag change to ${subject.environment.name} (${touched})`, 200),
    ...(appOrigin !== undefined && {
      url: `${appOrigin}/workspaces/${subject.workspaceId}/p/${subject.projectId}/flags?env=${subject.environment.id}`,
    }),
    severity,
    fields: [
      { name: 'Environment', value: subject.environment.name, inline: true },
      { name: 'Changes', value: String(subject.diff.length), inline: true },
      { name: 'Requested by', value: clip(subject.requestedBy, 200), inline: false },
      ...(subject.reason === null ? [] : [{ name: 'Reason', value: clip(subject.reason, 500), inline: false }]),
    ],
    footer: 'Mocco feature flags',
  };
}
