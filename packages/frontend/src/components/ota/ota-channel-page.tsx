import { OtaDeploymentKinds, OtaPlatforms, TimelineRanges } from '@mocco/common/ota-hosting';
import Link from 'next/link';
import { useRouter } from 'next/router';

import { Ago, Notice, Spinner, StatusBadge, Tones } from '@frontend/components/notifications/notification-ui';
import { HeadControls, PendingPromotionRequests } from '@frontend/components/ota/ota-hosting';
import { describeApprovalPolicy } from '@frontend/components/ota/policy-text';
import { Routes } from '@frontend/lib/routes';
import { trpc } from '@frontend/lib/trpc';
import { useWorkspaceAdmin } from '@frontend/lib/use-workspace-admin';

import type {
  OtaAppDto,
  OtaChannelDto,
  OtaDeploymentDto,
  OtaDeploymentKind,
  TimelineRange,
} from '@mocco/common/ota-hosting';

interface Props {
  workspaceId: string;
  projectId: string;
  channelId: string;
}

const kindLabels: Record<OtaDeploymentKind, string> = {
  [OtaDeploymentKinds.promote]: 'Promoted',
  [OtaDeploymentKinds.rollout]: 'Rollout',
  [OtaDeploymentKinds.pause]: 'Paused',
  [OtaDeploymentKinds.resume]: 'Resumed',
  [OtaDeploymentKinds.complete]: 'Completed',
  [OtaDeploymentKinds.rollback]: 'Rolled back',
  [OtaDeploymentKinds.rollbackEmbedded]: 'Rolled back to embedded',
  [OtaDeploymentKinds.disable]: 'Disabled',
};

const kindTones: Partial<Record<OtaDeploymentKind, (typeof Tones)[keyof typeof Tones]>> = {
  [OtaDeploymentKinds.promote]: Tones.ok,
  [OtaDeploymentKinds.complete]: Tones.ok,
  [OtaDeploymentKinds.rollout]: Tones.warn,
  [OtaDeploymentKinds.pause]: Tones.warn,
  [OtaDeploymentKinds.rollback]: Tones.danger,
  [OtaDeploymentKinds.rollbackEmbedded]: Tones.danger,
};

const rangeLabels: Record<TimelineRange, string> = {
  [TimelineRanges.week]: '7 days',
  [TimelineRanges.month]: '30 days',
  [TimelineRanges.all]: 'All',
};

const share = (bp: number | null) => (bp === null ? '' : `${bp / 100}%`);

function TimelineEntry(props: { entry: OtaDeploymentDto; workspaceId: string; projectId: string; app: OtaAppDto }) {
  const { entry, workspaceId, projectId, app } = props;
  const isShareChange = entry.kind === OtaDeploymentKinds.rollout || entry.kind === OtaDeploymentKinds.complete;
  return (
    <li className="flex flex-col gap-1 border-l-2 border-border py-1 pl-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <StatusBadge tone={kindTones[entry.kind] ?? Tones.neutral}>{kindLabels[entry.kind]}</StatusBadge>
        {entry.releaseId === null ? null : (
          <Link
            href={Routes.projectOtaRelease(workspaceId, projectId, app.id, entry.releaseId)}
            className="font-medium underline-offset-2 hover:underline">
            {entry.releaseMessage ?? entry.releaseId.slice(0, 8)}
          </Link>
        )}
        {isShareChange ? (
          <span className="font-mono text-xs text-muted-foreground">
            {entry.fromBp === null ? '' : `${share(entry.fromBp)} → `}
            {share(entry.toBp)}
          </span>
        ) : null}
        {entry.gitSha === null ? null : (
          <span className="font-mono text-xs text-muted-foreground">{entry.gitSha.slice(0, 7)}</span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        <Ago date={entry.createdAt} /> by {entry.actorName ?? entry.actorPrincipal ?? 'someone'}
        {entry.approvalRequestId === null ? '' : ' · approved'}
        {entry.reason === null ? '' : ` · “${entry.reason}”`}
      </p>
    </li>
  );
}

function ChannelView({
  workspaceId,
  projectId,
  app,
  channel,
}: Omit<Props, 'channelId'> & { app: OtaAppDto; channel: OtaChannelDto }) {
  const router = useRouter();
  const { isAdmin } = useWorkspaceAdmin(workspaceId);
  const platform = typeof router.query.platform === 'string' ? router.query.platform : undefined;
  const rangeQuery = typeof router.query.range === 'string' ? router.query.range : TimelineRanges.month;
  const range = (Object.values(TimelineRanges) as string[]).includes(rangeQuery)
    ? (rangeQuery as TimelineRange)
    : TimelineRanges.month;
  const timelineQuery = trpc.ota.hosting.channels.timeline.useQuery({
    workspaceId,
    projectId,
    appId: app.id,
    channelId: channel.id,
    range,
  });
  const view = (next: { platform?: string; range?: string }) =>
    Routes.projectOtaChannel(workspaceId, projectId, app.id, channel.id, {
      ...(platform !== undefined && { platform }),
      range,
      ...next,
    });
  const deployments = timelineQuery.data?.deployments ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <Link
          href={Routes.projectOtaHosting(workspaceId, projectId, app.id)}
          className="text-xs text-muted-foreground underline-offset-2 hover:underline">
          ← OTA hosting
        </Link>
        <h2 className="flex items-center gap-2 text-base font-medium">
          <span className="font-mono">{channel.name}</span>
          {channel.isProtected ? (
            <StatusBadge tone={Tones.warn}>Protected</StatusBadge>
          ) : (
            <StatusBadge tone={Tones.neutral}>Open</StatusBadge>
          )}
        </h2>
        <p className="text-xs text-muted-foreground">
          {channel.isProtected
            ? `Promotions and rollout changes need ${describeApprovalPolicy(channel.policy)}; pause and rollback never wait.`
            : 'Promotions apply at once.'}
        </p>
      </div>
      <nav aria-label="Platform" className="flex flex-wrap gap-2 text-xs">
        {[undefined, OtaPlatforms.ios, OtaPlatforms.android].map(option => (
          <Link
            key={option ?? 'all'}
            href={Routes.projectOtaChannel(workspaceId, projectId, app.id, channel.id, {
              ...(option !== undefined && { platform: option }),
              range,
            })}
            aria-current={option === platform ? 'page' : undefined}
            className={`rounded-full border px-3 py-1 ${option === platform ? 'border-foreground font-medium' : 'border-border text-muted-foreground'}`}>
            {option ?? 'All platforms'}
          </Link>
        ))}
      </nav>
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Serving now</h3>
        <HeadControls
          workspaceId={workspaceId}
          projectId={projectId}
          app={app}
          isAdmin={isAdmin}
          channel={channel}
          {...(platform !== undefined && { platform })}
        />
        <PendingPromotionRequests
          workspaceId={workspaceId}
          projectId={projectId}
          app={app}
          isAdmin={isAdmin}
          channel={channel}
        />
      </section>
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium">History</h3>
          <nav aria-label="Range" className="flex gap-2 text-xs">
            {Object.values(TimelineRanges).map(option => (
              <Link
                key={option}
                href={view({ range: option })}
                aria-current={option === range ? 'page' : undefined}
                className={option === range ? 'font-medium underline underline-offset-2' : 'text-muted-foreground'}>
                {rangeLabels[option]}
              </Link>
            ))}
          </nav>
        </div>
        {timelineQuery.isPending ? <Spinner /> : null}
        {timelineQuery.isSuccess && deployments.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing changed on this channel in this range.</p>
        ) : null}
        <ol className="flex flex-col gap-2">
          {deployments.map(entry => (
            <TimelineEntry key={entry.id} entry={entry} workspaceId={workspaceId} projectId={projectId} app={app} />
          ))}
        </ol>
      </section>
    </div>
  );
}

/**
 * One hosted OTA channel: what it serves and rolls out per platform, its waiting requests,
 * and its history. Platform and range are URL state (`?platform=`, `?range=`).
 */
export default function OtaChannelPage({ workspaceId, projectId, channelId }: Props) {
  const router = useRouter();
  const appId = typeof router.query.app === 'string' ? router.query.app : undefined;
  const appsQuery = trpc.ota.hosting.apps.list.useQuery({ workspaceId, projectId });
  const app = appsQuery.data?.apps.find(candidate => candidate.id === appId) ?? appsQuery.data?.apps[0];
  const channelsQuery = trpc.ota.hosting.channels.list.useQuery(
    { workspaceId, projectId, appId: app?.id ?? '' },
    { enabled: app !== undefined },
  );
  const channel = channelsQuery.data?.channels.find(candidate => candidate.id === channelId);
  if (appsQuery.isPending || (app !== undefined && channelsQuery.isPending)) {
    return <Spinner />;
  }
  if (app === undefined || channel === undefined) {
    return (
      <Notice tone={Tones.neutral} title="Channel not found">
        It may belong to another OTA app.
      </Notice>
    );
  }
  return <ChannelView workspaceId={workspaceId} projectId={projectId} app={app} channel={channel} />;
}
