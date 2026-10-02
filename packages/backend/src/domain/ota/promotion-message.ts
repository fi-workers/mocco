// The notification messages for promotions to protected channels (rendered when the
// event is recorded, like inbound messages). Pure.
import { OtaEventTypes } from '@mocco/common/events';
import { Severities } from '@mocco/common/notification';

import type { OtaAppRow } from '@backend/domain/ota/repos/ota-app.repo';
import type { OtaChannelRow } from '@backend/domain/ota/repos/ota-channel.repo';
import type { OtaReleaseRow } from '@backend/domain/ota/repos/ota-release.repo';
import type { NeutralMessage } from '@mocco/common/notification';

type OtaEventType = (typeof OtaEventTypes)[keyof typeof OtaEventTypes];

const headlines: Record<OtaEventType, { verb: string; severity: NeutralMessage['severity'] }> = {
  [OtaEventTypes.otaPromotionRequested]: { verb: 'Approval needed', severity: Severities.warning },
  [OtaEventTypes.otaPromotionApproved]: { verb: 'Promoted', severity: Severities.success },
  [OtaEventTypes.otaPromotionRejected]: { verb: 'Promotion rejected', severity: Severities.error },
};

// eslint-disable-next-line sonarjs/null-dereference -- value is a string, never null
const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

export function promotionMessage(
  type: OtaEventType,
  subject: { app: OtaAppRow; channel: OtaChannelRow; release: OtaReleaseRow; requestedBy: string },
  appOrigin: string | undefined,
): NeutralMessage {
  const { app, channel, release } = subject;
  const { verb, severity } = headlines[type];
  const name = clip(release.message ?? release.id, 120);
  return {
    title: clip(`${verb}: ${name} → ${channel.name}`, 200),
    ...(appOrigin !== undefined && {
      url: `${appOrigin}/workspaces/${app.workspaceId}/p/${app.projectId}/ota-hosting?app=${app.id}`,
    }),
    severity,
    fields: [
      { name: 'Channel', value: channel.name, inline: true },
      { name: 'Runtime', value: release.runtimeVersion, inline: true },
      ...(release.gitSha === null ? [] : [{ name: 'Commit', value: release.gitSha.slice(0, 12), inline: true }]),
      { name: 'Requested by', value: clip(subject.requestedBy, 200), inline: false },
    ],
    footer: 'Mocco OTA',
  };
}
