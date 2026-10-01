import { OtaReleaseStatuses } from '@mocco/common/ota-hosting';
import Link from 'next/link';
import { useRouter } from 'next/router';

import { Ago, Notice, Spinner, StatusBadge, Tones } from '@frontend/components/notifications/notification-ui';
import { AdoptionLine, formatBytes, PromoteControl } from '@frontend/components/ota/ota-hosting';
import { Routes } from '@frontend/lib/routes';
import { trpc } from '@frontend/lib/trpc';
import { useWorkspaceAdmin } from '@frontend/lib/use-workspace-admin';

import type { OtaAppDto } from '@mocco/common/ota-hosting';

interface Props {
  workspaceId: string;
  projectId: string;
  releaseId: string;
}

const percentOf = (bp: number) => `${bp / 100}%`;

function ReleaseView({ workspaceId, projectId, releaseId, app }: Props & { app: OtaAppDto }) {
  const { isAdmin } = useWorkspaceAdmin(workspaceId);
  const input = { workspaceId, projectId, appId: app.id };
  const detailQuery = trpc.ota.hosting.releases.get.useQuery({ ...input, releaseId });
  const adoptionQuery = trpc.ota.hosting.metrics.adoption.useQuery(input);
  const channelsQuery = trpc.ota.hosting.channels.list.useQuery(input);
  if (detailQuery.isPending) {
    return <Spinner />;
  }
  if (detailQuery.data === undefined) {
    return (
      <Notice tone={Tones.neutral} title="Release not found">
        It may belong to another OTA app.
      </Notice>
    );
  }
  const { release, updates, servedOn, approvals } = detailQuery.data;
  const channelName = (channelId: string) =>
    // eslint-disable-next-line sonarjs/null-dereference -- channelId is a string, never null
    channelsQuery.data?.channels.find(channel => channel.id === channelId)?.name ?? channelId.slice(0, 8);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <Link
          href={Routes.projectOtaHosting(workspaceId, projectId, app.id)}
          className="text-xs text-muted-foreground underline-offset-2 hover:underline">
          ← OTA hosting
        </Link>
        <h2 className="flex flex-wrap items-center gap-2 text-base font-medium">
          {release.message ?? 'Untitled release'}
          <StatusBadge tone={release.status === OtaReleaseStatuses.ready ? Tones.ok : Tones.neutral}>
            {release.status}
          </StatusBadge>
          {release.isMandatory ? <StatusBadge tone={Tones.warn}>Mandatory</StatusBadge> : null}
        </h2>
        <p className="font-mono text-xs text-muted-foreground">
          runtime {release.runtimeVersion} · {release.platforms.join(', ')} · {formatBytes(release.downloadBytes)}{' '}
          download
          {release.gitSha === null ? '' : ` · commit ${release.gitSha.slice(0, 12)}`}
        </p>
        <p className="text-xs text-muted-foreground">
          Uploaded <Ago date={release.createdAt} />
          {release.uploadedByPrincipal === null ? '' : ` by ${release.uploadedByPrincipal}`}
          {release.isMandatory ? ' · devices apply it at the next safe point (useMoccoUpdate)' : ''}
        </p>
      </div>
      <AdoptionLine adoption={adoptionQuery.data?.releases.find(entry => entry.releaseId === release.id)} />
      {release.status === OtaReleaseStatuses.ready ? (
        <PromoteControl workspaceId={workspaceId} projectId={projectId} app={app} isAdmin={isAdmin} release={release} />
      ) : null}
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Served on</h3>
        {servedOn.length === 0 ? (
          <p className="text-sm text-muted-foreground">No channel serves it right now.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {servedOn.map(entry => (
              <li key={`${entry.channelId}-${entry.platform}-${entry.runtimeVersion}`}>
                <Link
                  href={Routes.projectOtaChannel(workspaceId, projectId, app.id, entry.channelId, {
                    platform: entry.platform,
                  })}
                  className="font-mono underline-offset-2 hover:underline">
                  {entry.channel}
                </Link>{' '}
                <span className="text-xs text-muted-foreground">
                  {entry.platform} · runtime {entry.runtimeVersion} ·{' '}
                  {entry.role === 'candidate' ? `rolling out to ${percentOf(entry.rolloutBp)}` : 'everyone'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Signed updates</h3>
        <table className="w-full text-left text-xs">
          <thead className="text-muted-foreground">
            <tr>
              <th scope="col" className="py-1 font-medium">
                Platform
              </th>
              <th scope="col" className="py-1 font-medium">
                Kind
              </th>
              <th scope="col" className="py-1 font-medium">
                Update
              </th>
              <th scope="col" className="py-1 font-medium">
                Created
              </th>
              <th scope="col" className="py-1 font-medium">
                Size
              </th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {updates.map(update => (
              <tr key={update.id} className="border-t border-border">
                <td className="py-1">{update.platform}</td>
                <td className="py-1">
                  {update.kind === 'original'
                    ? 'release'
                    : `rollback (valid on ${update.supersedesUpdateId?.slice(0, 8) ?? '—'})`}
                </td>
                <td className="py-1">{update.id.slice(0, 8)}</td>
                <td className="py-1">{update.commitTime.toISOString().replace('T', ' ').slice(0, 19)}</td>
                <td className="py-1">{formatBytes(update.totalBytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Approvals</h3>
        {approvals.length === 0 ? (
          <p className="text-sm text-muted-foreground">No approval was needed for this release.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {approvals.map(approval => (
              <li key={approval.requestId}>
                Promote to <span className="font-mono">{channelName(approval.channelId)}</span> ·{' '}
                <StatusBadge tone={approval.state === 'approved' ? Tones.ok : Tones.neutral}>
                  {approval.state}
                </StatusBadge>{' '}
                <span className="text-xs text-muted-foreground">
                  <Ago date={approval.createdAt} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** One hosted OTA release: its signed updates, where it's served, adoption and approvals. */
export default function OtaReleasePage({ workspaceId, projectId, releaseId }: Props) {
  const router = useRouter();
  const appId = typeof router.query.app === 'string' ? router.query.app : undefined;
  const appsQuery = trpc.ota.hosting.apps.list.useQuery({ workspaceId, projectId });
  const app = appsQuery.data?.apps.find(candidate => candidate.id === appId) ?? appsQuery.data?.apps[0];
  if (appsQuery.isPending) {
    return <Spinner />;
  }
  if (app === undefined) {
    return (
      <Notice tone={Tones.neutral} title="No hosted OTA app">
        This project doesn&apos;t host OTA updates yet.
      </Notice>
    );
  }
  return <ReleaseView workspaceId={workspaceId} projectId={projectId} releaseId={releaseId} app={app} />;
}
