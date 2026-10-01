import { ApprovalDecisions, ApprovalStates, gateRequirementsSchema } from '@mocco/common/governance';
import {
  ChannelPolicyOutcomes,
  DEFAULT_SIGNING_KEY_ID,
  OtaHostingApprovalSubjects,
  OtaReleaseStatuses,
} from '@mocco/common/ota-hosting';
import { AppPlatforms } from '@mocco/common/project';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { z } from 'zod';

import {
  Ago,
  CopyField,
  errorMessage,
  inputClass,
  labelClass,
  Notice,
  Spinner,
  StatusBadge,
  Tones,
} from '@frontend/components/notifications/notification-ui';
import { describeApprovalPolicy } from '@frontend/components/ota/policy-text';
import { Button } from '@frontend/components/ui/button';
import { useSession } from '@frontend/lib/auth-client';
import { Routes } from '@frontend/lib/routes';
import { trpc } from '@frontend/lib/trpc';
import { useWorkspaceAdmin } from '@frontend/lib/use-workspace-admin';

import type { GateRequirements } from '@mocco/common/governance';
import type { OtaAppDto, OtaChannelDto, OtaReleaseDto, OtaReleaseStatus } from '@mocco/common/ota-hosting';

/** The policy a channel-policy approval would apply. */
const pinnedPolicySchema = z.object({ policy: gateRequirementsSchema.nullable() });

interface Props {
  workspaceId: string;
  projectId: string;
}

interface AppProps extends Props {
  app: OtaAppDto;
  isAdmin: boolean;
}

/** The `expo.updates` block of the app's config, pointing at Mocco. */
function updatesConfig(app: OtaAppDto, channel: string): string {
  return JSON.stringify(
    {
      updates: {
        url: app.manifestUrl,
        requestHeaders: { 'expo-channel-name': channel },
        codeSigningCertificate: './certs/certificate.pem',
        codeSigningMetadata: { keyid: DEFAULT_SIGNING_KEY_ID, alg: 'rsa-v1_5-sha256' },
      },
    },
    null,
    2,
  );
}

function SetupCard({ app, channels }: { app: OtaAppDto; channels: readonly OtaChannelDto[] }) {
  const channel = channels[0]?.name ?? 'production';
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border p-4">
      <div>
        <h2 className="text-sm font-medium">Connect the app</h2>
        <p className="text-xs text-muted-foreground">
          The app keeps the stock <span className="font-mono">expo-updates</span> module (bare React Native apps install
          it too). Point it at Mocco in <span className="font-mono">app.json</span> under{' '}
          <span className="font-mono">expo</span>. The URL is fixed for the life of the app.
        </p>
      </div>
      <CopyField label="Manifest URL" value={app.manifestUrl} />
      <pre className="overflow-x-auto rounded-lg bg-muted/40 p-3 font-mono text-xs">{updatesConfig(app, channel)}</pre>
      <p className="text-xs text-muted-foreground">
        Asset URLs in signed manifests start with <span className="font-mono">{app.assetBaseUrl}</span>.
      </p>
    </section>
  );
}

function Certificates({ workspaceId, projectId, app, isAdmin }: AppProps) {
  const utils = trpc.useUtils();
  const input = { workspaceId, projectId, appId: app.id };
  const certificatesQuery = trpc.ota.hosting.certificates.list.useQuery(input);
  const [pem, setPem] = useState('');
  const [keyid, setKeyid] = useState(DEFAULT_SIGNING_KEY_ID);
  const invalidate = async () => {
    await utils.ota.hosting.certificates.list.invalidate(input);
  };
  const addition = trpc.ota.hosting.certificates.add.useMutation({
    onSuccess: async () => {
      setPem('');
      await invalidate();
    },
  });
  const retirement = trpc.ota.hosting.certificates.retire.useMutation({ onSuccess: invalidate });
  const certificates = certificatesQuery.data?.certificates ?? [];

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-medium">Signing certificates</h2>
        <p className="text-xs text-muted-foreground">
          Your CI signs every update with its private key; Mocco keeps only the certificate and refuses any upload whose
          signature doesn&apos;t verify against an active one.
        </p>
      </div>
      {certificatesQuery.isSuccess && certificates.length === 0 ? (
        <Notice tone={Tones.warn} title="No certificate yet">
          Uploads are refused until the certificate your app embeds is registered here.
        </Notice>
      ) : null}
      <ul className="flex flex-col gap-2">
        {certificates.map(certificate => (
          <li key={certificate.id} className="flex flex-col gap-1 rounded-xl border border-border px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">{certificate.subject}</span>
                <StatusBadge tone={certificate.status === 'active' ? Tones.ok : Tones.neutral}>
                  {certificate.status === 'active' ? 'Active' : 'Retired'}
                </StatusBadge>
              </span>
              {isAdmin && certificate.status === 'active' ? (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Retire ${certificate.subject}`}
                  pending={retirement.isPending && retirement.variables.certificateId === certificate.id}
                  onClick={() => {
                    retirement.mutate({ ...input, certificateId: certificate.id });
                  }}>
                  Retire
                </Button>
              ) : null}
            </div>
            <p className="font-mono text-xs text-muted-foreground">
              keyid {certificate.keyid} · key {certificate.spkiSha256.slice(0, 16)}… · expires{' '}
              {certificate.notAfter.toLocaleDateString()}
            </p>
          </li>
        ))}
      </ul>
      {isAdmin ? (
        <form
          aria-label="Add a signing certificate"
          className="flex flex-col gap-2 rounded-xl bg-muted/40 p-4"
          onSubmit={event => {
            event.preventDefault();
            addition.mutate({ ...input, certificatePem: pem, keyid });
          }}>
          <label className={labelClass}>
            Certificate (PEM)
            <textarea
              required
              rows={5}
              value={pem}
              placeholder="-----BEGIN CERTIFICATE-----"
              onChange={event => {
                setPem(event.target.value);
              }}
              className={`${inputClass} h-auto py-1.5 font-mono text-xs`}
            />
          </label>
          <label className={`${labelClass} w-48`}>
            keyid (codeSigningMetadata)
            <input
              required
              value={keyid}
              onChange={event => {
                setKeyid(event.target.value);
              }}
              className={`${inputClass} font-mono`}
            />
          </label>
          {addition.error ? <p className="text-sm text-destructive">{errorMessage(addition.error)}</p> : null}
          <Button type="submit" pending={addition.isPending} disabled={pem === ''} className="w-fit text-sm">
            Add certificate
          </Button>
        </form>
      ) : null}
    </section>
  );
}

function PolicyEditor({
  workspaceId,
  channel,
  onSubmit,
  isPending,
}: {
  workspaceId: string;
  channel: OtaChannelDto;
  onSubmit: (policy: GateRequirements | null) => void;
  isPending: boolean;
}) {
  const rolesQuery = trpc.role.list.useQuery({ workspaceId });
  const roles = rolesQuery.data?.roles ?? [];
  const current = channel.policy?.resume[0];
  const [role, setRole] = useState(current?.role ?? '');
  const [count, setCount] = useState(current?.count ?? 1);
  const [isSelfPrevented, setIsSelfPrevented] = useState(channel.policy?.prevent_self ?? true);
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
        {channel.isProtected ? 'Change protection' : 'Protect channel'}
      </Button>
      {channel.isProtected ? (
        <Button
          variant="outline"
          className="text-sm"
          pending={isPending}
          onClick={() => {
            onSubmit(null);
          }}>
          Remove protection
        </Button>
      ) : null}
    </div>
  );
}

function PendingPolicyRequests({ workspaceId, projectId, app, channel }: AppProps & { channel: OtaChannelDto }) {
  const utils = trpc.useUtils();
  const requestsQuery = trpc.approval.list.useQuery({
    workspaceId,
    subjectType: OtaHostingApprovalSubjects.channelPolicy,
    subjectId: channel.id,
    state: ApprovalStates.pending,
  });
  const vote = trpc.approval.vote.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.approval.list.invalidate({ workspaceId }),
        utils.ota.hosting.channels.list.invalidate({ workspaceId, projectId, appId: app.id }),
      ]);
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
        const pinned = pinnedPolicySchema.safeParse(request.action);
        const target = pinned.success ? pinned.data.policy : null;
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

/** What a channel serves now, per runtime: the release behind each platform's head. */
function ServingLine({ workspaceId, projectId, app, channel }: AppProps & { channel: OtaChannelDto }) {
  const input = { workspaceId, projectId, appId: app.id };
  const headsQuery = trpc.ota.hosting.channels.heads.useQuery(input);
  const releasesQuery = trpc.ota.hosting.releases.list.useQuery(input);
  const heads = (headsQuery.data?.heads ?? []).filter(head => head.channelId === channel.id && head.releaseId !== null);
  if (headsQuery.isSuccess && heads.length === 0) {
    return <p className="text-xs text-muted-foreground">Serves nothing yet: builds keep their embedded bundle.</p>;
  }
  const releaseIds = heads
    .map(head => head.releaseId)
    .filter((id, index, all) => id !== null && all.indexOf(id) === index);
  return (
    <ul className="flex flex-col gap-1">
      {releaseIds.map(releaseId => {
        const release = releasesQuery.data?.releases.find(candidate => candidate.id === releaseId);
        const served = heads.filter(head => head.releaseId === releaseId);
        return (
          <li key={releaseId} className="text-xs">
            Serving <span className="font-medium">{release?.message ?? releaseId?.slice(0, 8)}</span>{' '}
            <span className="font-mono text-muted-foreground">
              · {served.map(head => head.platform).join(', ')} · runtime {served[0]?.runtimeVersion}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

const formatBytes = (bytes: number) =>
  bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** The pinned action of a promotion request (what the handler will apply). */
const pinnedPromotionSchema = z.object({
  releaseId: z.uuid(),
  reason: z.string().nullable(),
  principal: z.string().nullable(),
});

/** The release, its size and what it would change on the channel. */
function PromotionDiff(props: AppProps & { channel: OtaChannelDto; releaseId: string }) {
  const { workspaceId, projectId, app, channel, releaseId } = props;
  const previewQuery = trpc.ota.hosting.channels.previewPromotion.useQuery({
    workspaceId,
    projectId,
    appId: app.id,
    channelId: channel.id,
    releaseId,
  });
  const preview = previewQuery.data;
  if (preview === undefined) {
    return null;
  }
  return (
    <ul className="flex flex-col gap-0.5 font-mono text-xs text-muted-foreground">
      {preview.platforms.map(platform => (
        <li key={platform.platform}>
          {platform.platform}:{' '}
          {platform.replacesUpdateId === null ? 'first update on this channel' : 'replaces the current update'} ·{' '}
          {platform.newAssets} new asset(s), {formatBytes(platform.newBytes)} to download
          {platform.removedAssets > 0 ? ` · ${platform.removedAssets} dropped` : ''}
        </li>
      ))}
    </ul>
  );
}

/** Promotions to a protected channel waiting for approval, with what they'd ship. */
function PendingPromotionRequests(props: AppProps & { channel: OtaChannelDto }) {
  const { workspaceId, projectId, app, channel } = props;
  const utils = trpc.useUtils();
  const input = { workspaceId, projectId, appId: app.id };
  const requestsQuery = trpc.approval.list.useQuery({
    workspaceId,
    subjectType: OtaHostingApprovalSubjects.channelChange,
    subjectId: channel.id,
    state: ApprovalStates.pending,
  });
  const releasesQuery = trpc.ota.hosting.releases.list.useQuery(input);
  const vote = trpc.approval.vote.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.approval.list.invalidate({ workspaceId }),
        utils.ota.hosting.channels.heads.invalidate(input),
      ]);
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
        const pinned = pinnedPromotionSchema.safeParse(request.action);
        const releaseId = pinned.success ? pinned.data.releaseId : null;
        const release = releasesQuery.data?.releases.find(candidate => candidate.id === releaseId);
        const isMine = request.requirements.prevent_self && myUserId !== null && request.requestedByUserId === myUserId;
        return (
          <div
            key={request.id}
            className="flex flex-col gap-2 rounded-lg border border-amber-600/30 bg-amber-500/5 p-3">
            <p className="text-sm">
              <StatusBadge tone={Tones.warn}>Waiting for approval</StatusBadge>{' '}
              <span className="font-medium">Promote {release?.message ?? releaseId?.slice(0, 8)}</span>{' '}
              <span className="text-muted-foreground">
                · requested <Ago date={request.createdAt} />
                {pinned.success && pinned.data.principal !== null ? ` by ${pinned.data.principal}` : ''}
              </span>
            </p>
            {release === undefined ? null : (
              <p className="font-mono text-xs text-muted-foreground">
                runtime {release.runtimeVersion} · {release.platforms.join(', ')} · {formatBytes(release.downloadBytes)}{' '}
                download{release.gitSha === null ? '' : ` · ${release.gitSha.slice(0, 7)}`}
              </p>
            )}
            {releaseId === null ? null : (
              <PromotionDiff
                workspaceId={workspaceId}
                projectId={projectId}
                app={app}
                isAdmin={props.isAdmin}
                channel={channel}
                releaseId={releaseId}
              />
            )}
            {pinned.success && pinned.data.reason !== null ? (
              <p className="text-xs">Reason: {pinned.data.reason}</p>
            ) : null}
            <p className="text-xs text-muted-foreground">Needs {describeApprovalPolicy(request.requirements)}.</p>
            {isMine ? (
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

function ChannelRow(props: AppProps & { channel: OtaChannelDto }) {
  const { workspaceId, projectId, app, channel } = props;
  const utils = trpc.useUtils();
  const [isEditing, setIsEditing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const change = trpc.ota.hosting.channels.changePolicy.useMutation({
    onSuccess: async result => {
      setIsEditing(false);
      setNotice(
        result.outcome === ChannelPolicyOutcomes.applied
          ? 'Applied.'
          : 'Sent for approval under the current protection. It applies once approved.',
      );
      await Promise.all([
        utils.ota.hosting.channels.list.invalidate({ workspaceId, projectId, appId: app.id }),
        utils.approval.list.invalidate({ workspaceId }),
      ]);
    },
  });

  return (
    <li className="flex flex-col gap-2 rounded-xl border border-border px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          <span className="font-mono text-sm font-medium">{channel.name}</span>
          {channel.isProtected ? (
            <StatusBadge tone={Tones.warn}>Protected</StatusBadge>
          ) : (
            <StatusBadge tone={Tones.neutral}>Open</StatusBadge>
          )}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setIsEditing(value => !value);
          }}>
          {isEditing ? 'Close' : 'Protection'}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {channel.isProtected
          ? `Promotions need ${describeApprovalPolicy(channel.policy)}.`
          : 'Promotions apply at once. Protect it to require approval.'}
      </p>
      {isEditing ? (
        <PolicyEditor
          workspaceId={workspaceId}
          channel={channel}
          isPending={change.isPending}
          onSubmit={policy => {
            setNotice(null);
            change.mutate({ workspaceId, projectId, appId: app.id, channelId: channel.id, policy });
          }}
        />
      ) : null}
      <ServingLine {...props} />
      {notice === null ? null : <p className="text-xs text-muted-foreground">{notice}</p>}
      {change.error ? <p className="text-sm text-destructive">{errorMessage(change.error)}</p> : null}
      <PendingPolicyRequests {...props} />
      <PendingPromotionRequests {...props} />
    </li>
  );
}

function Channels(props: AppProps & { channels: readonly OtaChannelDto[] }) {
  const { workspaceId, projectId, app, channels } = props;
  const utils = trpc.useUtils();
  const [name, setName] = useState('');
  const creation = trpc.ota.hosting.channels.create.useMutation({
    onSuccess: async () => {
      setName('');
      await utils.ota.hosting.channels.list.invalidate({ workspaceId, projectId, appId: app.id });
    },
  });

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-medium">Channels</h2>
        <p className="text-xs text-muted-foreground">
          A build reads updates from the channel in its <span className="font-mono">expo-channel-name</span> header.
          Changing an existing protection is itself approved under the current one.
        </p>
      </div>
      <ul className="flex flex-col gap-2">
        {channels.map(channel => (
          <ChannelRow
            key={channel.id}
            workspaceId={workspaceId}
            projectId={projectId}
            app={app}
            isAdmin={props.isAdmin}
            channel={channel}
          />
        ))}
      </ul>
      <form
        aria-label="Create a channel"
        className="flex flex-wrap items-end gap-2"
        onSubmit={event => {
          event.preventDefault();
          creation.mutate({ workspaceId, projectId, appId: app.id, name });
        }}>
        <label className={labelClass}>
          New channel
          <input
            required
            value={name}
            placeholder={channels.length === 0 ? 'production' : 'staging'}
            onChange={event => {
              setName(event.target.value);
            }}
            className={`${inputClass} font-mono`}
          />
        </label>
        <Button type="submit" variant="outline" pending={creation.isPending} disabled={name === ''} className="text-sm">
          Create channel
        </Button>
      </form>
      {creation.error ? <p className="text-sm text-destructive">{errorMessage(creation.error)}</p> : null}
    </section>
  );
}

const releaseStatusLabels: Record<OtaReleaseStatus, string> = {
  [OtaReleaseStatuses.uploading]: 'Uploading',
  [OtaReleaseStatuses.verifying]: 'Verifying',
  [OtaReleaseStatuses.ready]: 'Ready',
  [OtaReleaseStatuses.failed]: 'Failed',
  [OtaReleaseStatuses.disabled]: 'Disabled',
};

const releaseStatusTones = {
  [OtaReleaseStatuses.uploading]: Tones.neutral,
  [OtaReleaseStatuses.verifying]: Tones.warn,
  [OtaReleaseStatuses.ready]: Tones.ok,
  [OtaReleaseStatuses.failed]: Tones.danger,
  [OtaReleaseStatuses.disabled]: Tones.neutral,
} as const;

function promotionNotice(result: { channel: string; platforms: string[]; changed: boolean; outcome: string }) {
  if (result.outcome === ChannelPolicyOutcomes.pendingApproval) {
    return `Sent for approval: ${result.channel} changes once it is approved.`;
  }
  return result.changed
    ? `Promoted to ${result.channel} (${result.platforms.join(', ')}).`
    : `${result.channel} already serves this release.`;
}

/** Promote a ready release: at once to an open channel, as an approval request to a protected one. */
function PromoteControl({ workspaceId, projectId, app, release }: AppProps & { release: OtaReleaseDto }) {
  const utils = trpc.useUtils();
  const input = { workspaceId, projectId, appId: app.id };
  const channelsQuery = trpc.ota.hosting.channels.list.useQuery(input);
  const channels = channelsQuery.data?.channels ?? [];
  const [channelId, setChannelId] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const promotion = trpc.ota.hosting.channels.promote.useMutation({
    onSuccess: async result => {
      setNotice(promotionNotice(result));
      await Promise.all([
        utils.ota.hosting.channels.heads.invalidate(input),
        utils.approval.list.invalidate({ workspaceId }),
      ]);
    },
  });
  const selected =
    channels.find(channel => channel.id === channelId) ?? channels.find(channel => !channel.isProtected) ?? channels[0];
  if (channels.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label={`Channel to promote ${release.message ?? release.id} to`}
          className={`${inputClass} w-auto py-1 text-xs`}
          value={selected?.id ?? ''}
          onChange={event => {
            setChannelId(event.target.value);
            setNotice(null);
          }}>
          {channels.map(channel => (
            <option key={channel.id} value={channel.id}>
              {channel.isProtected ? `${channel.name} (protected: needs approval)` : channel.name}
            </option>
          ))}
        </select>
        <Button
          variant="outline"
          size="sm"
          disabled={selected === undefined}
          pending={promotion.isPending}
          onClick={() => {
            if (selected === undefined) {
              return;
            }

            setNotice(null);
            promotion.mutate({ ...input, channelId: selected.id, releaseId: release.id });
          }}>
          {selected?.isProtected ? 'Request approval' : 'Promote'}
        </Button>
      </div>
      {notice === null ? null : <p className="text-xs text-muted-foreground">{notice}</p>}
      {promotion.error ? <p className="text-sm text-destructive">{errorMessage(promotion.error)}</p> : null}
    </div>
  );
}

function ReleaseRow(props: AppProps & { release: OtaReleaseDto }) {
  const { release } = props;
  return (
    <li className="flex flex-col gap-1 rounded-xl border border-border px-4 py-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{release.message ?? 'Untitled release'}</span>
        <StatusBadge tone={releaseStatusTones[release.status]}>{releaseStatusLabels[release.status]}</StatusBadge>
        {release.isMandatory ? <StatusBadge tone={Tones.warn}>Mandatory</StatusBadge> : null}
      </div>
      <p className="font-mono text-xs text-muted-foreground">
        runtime {release.runtimeVersion}
        {release.platforms.length > 0 ? ` · ${release.platforms.join(', ')}` : ''}
        {release.downloadBytes > 0 ? ` · ${formatBytes(release.downloadBytes)} download` : ''}
        {release.gitSha === null ? '' : ` · ${release.gitSha.slice(0, 7)}`}
      </p>
      <p className="text-xs text-muted-foreground">
        Uploaded <Ago date={release.createdAt} />
        {release.uploadedByPrincipal === null ? '' : ` by ${release.uploadedByPrincipal}`}
      </p>
      {release.status === OtaReleaseStatuses.ready ? <PromoteControl {...props} /> : null}
    </li>
  );
}

/** Releases CI uploaded, newest first. Polls while one is still being verified. */
function Releases(props: AppProps) {
  const { workspaceId, projectId, app } = props;
  const releasesQuery = trpc.ota.hosting.releases.list.useQuery(
    { workspaceId, projectId, appId: app.id },
    {
      refetchInterval: query =>
        query.state.data?.releases.some(release => release.status === OtaReleaseStatuses.verifying) === true
          ? 3000
          : false,
    },
  );
  const releases = releasesQuery.data?.releases ?? [];
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-medium">Releases</h2>
        <p className="text-xs text-muted-foreground">
          Publish from CI with <span className="font-mono">npx mocco-ota publish --app-id {app.id}</span> and a secret
          API key with <span className="font-mono">ota:write</span>. Mocco re-hashes new assets before a release is
          ready to promote.
        </p>
      </div>
      {releasesQuery.isPending ? <Spinner /> : null}
      {releasesQuery.isSuccess && releases.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          No releases yet.
        </p>
      ) : null}
      <ul className="flex flex-col gap-2">
        {releases.map(release => (
          <ReleaseRow
            key={release.id}
            workspaceId={workspaceId}
            projectId={projectId}
            app={app}
            isAdmin={props.isAdmin}
            release={release}
          />
        ))}
      </ul>
    </section>
  );
}

/** The GitHub Actions job that publishes with trusted publishing (no stored Mocco key). */
function workflowSnippet(app: OtaAppDto, channel: string): string {
  return [
    'permissions:',
    '  id-token: write # lets the job request its OIDC token',
    '  contents: read',
    'steps:',
    '  - uses: actions/checkout@v4',
    '  - uses: fi-workers/mocco/actions/ota-publish@main',
    '    with:',
    `      app-id: ${app.id}`,
    `      channel: ${channel}`,
    '    env:',
    // eslint-disable-next-line no-template-curly-in-string -- a GitHub Actions expression, not a JS template
    '      MOCCO_OTA_SIGNING_KEY: ${{ secrets.MOCCO_OTA_SIGNING_KEY }}',
  ].join('\n');
}

// eslint-disable-next-line sonarjs/null-dereference -- form state is a string, never null
const trimmed = (value: string) => value.trim();
const optionalOf = (value: string) => (trimmed(value) === '' ? null : trimmed(value));

function TrustPolicyForm(props: AppProps & { channels: readonly OtaChannelDto[]; onDone: () => void }) {
  const { workspaceId, projectId, app, channels, onDone } = props;
  const utils = trpc.useUtils();
  const [repository, setRepository] = useState('');
  const [repositoryId, setRepositoryId] = useState('');
  const [refPattern, setRefPattern] = useState('refs/heads/main');
  const [workflowRef, setWorkflowRef] = useState('');
  const [environment, setEnvironment] = useState('');
  const [allowed, setAllowed] = useState<string[]>([]);
  const creation = trpc.ota.hosting.trustPolicies.create.useMutation({
    onSuccess: async () => {
      await utils.ota.hosting.trustPolicies.list.invalidate({ workspaceId, projectId, appId: app.id });
      onDone();
    },
  });
  const open = channels.filter(channel => !channel.isProtected);
  const toggleChannel = (name: string, isOn: boolean) => {
    setAllowed(previous => (isOn ? [...previous, name] : previous.filter(other => other !== name)));
  };

  return (
    <form
      aria-label="Trust a GitHub repository"
      className="flex flex-col gap-3 rounded-xl bg-muted/40 p-4"
      onSubmit={event => {
        event.preventDefault();
        creation.mutate({
          workspaceId,
          projectId,
          appId: app.id,
          repository: trimmed(repository),
          repositoryId: trimmed(repositoryId),
          refPattern: trimmed(refPattern),
          workflowRef: optionalOf(workflowRef),
          environment: optionalOf(environment),
          allowedChannels: allowed,
        });
      }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={labelClass}>
          Repository
          <input
            required
            value={repository}
            placeholder="acme/mobile"
            onChange={event => {
              setRepository(event.target.value);
            }}
            className={inputClass}
          />
        </label>
        <label className={labelClass}>
          Repository id
          <input
            required
            inputMode="numeric"
            value={repositoryId}
            placeholder="123456789"
            onChange={event => {
              setRepositoryId(event.target.value);
            }}
            className={inputClass}
          />
        </label>
        <label className={labelClass}>
          Ref
          <input
            required
            value={refPattern}
            onChange={event => {
              setRefPattern(event.target.value);
            }}
            className={`${inputClass} font-mono`}
          />
        </label>
        <label className={labelClass}>
          Environment (optional)
          <input
            value={environment}
            placeholder="production"
            onChange={event => {
              setEnvironment(event.target.value);
            }}
            className={inputClass}
          />
        </label>
      </div>
      <label className={labelClass}>
        Workflow (optional)
        <input
          value={workflowRef}
          placeholder="acme/mobile/.github/workflows/ota.yml@refs/heads/main"
          onChange={event => {
            setWorkflowRef(event.target.value);
          }}
          className={`${inputClass} font-mono`}
        />
      </label>
      <p className="text-xs text-muted-foreground">
        The repository id is the numeric <span className="font-mono">id</span> at{' '}
        <span className="font-mono">api.github.com/repos/OWNER/REPO</span>: a renamed or forked repository has a
        different one. <span className="font-mono">*</span> in the ref matches anything (
        <span className="font-mono">refs/tags/v*</span>).
      </p>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1 text-xs font-medium text-muted-foreground">May promote to</legend>
        {open.length === 0 ? (
          <p className="text-xs text-muted-foreground">No open channels: it can upload but not promote.</p>
        ) : null}
        {open.map(channel => (
          <label key={channel.id} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={allowed.includes(channel.name)}
              onChange={event => {
                toggleChannel(channel.name, event.target.checked);
              }}
            />
            <span className="font-mono text-xs">{channel.name}</span>
          </label>
        ))}
      </fieldset>
      {creation.error ? <p className="text-sm text-destructive">{errorMessage(creation.error)}</p> : null}
      <div className="flex gap-2">
        <Button type="submit" pending={creation.isPending} className="w-fit text-sm">
          Trust repository
        </Button>
        <Button type="button" variant="ghost" className="text-sm" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** Trusted publishing: GitHub Actions jobs that may upload without a stored Mocco key. */
function TrustPolicies(props: AppProps & { channels: readonly OtaChannelDto[] }) {
  const { workspaceId, projectId, app, isAdmin, channels } = props;
  const utils = trpc.useUtils();
  const input = { workspaceId, projectId, appId: app.id };
  const policiesQuery = trpc.ota.hosting.trustPolicies.list.useQuery(input);
  const removal = trpc.ota.hosting.trustPolicies.delete.useMutation({
    onSuccess: async () => {
      await utils.ota.hosting.trustPolicies.list.invalidate(input);
    },
  });
  const [isAdding, setIsAdding] = useState(false);
  const policies = policiesQuery.data?.policies ?? [];
  const firstChannel = policies[0]?.allowedChannels[0] ?? 'staging';

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">Trusted publishing</h2>
          <p className="text-xs text-muted-foreground">
            GitHub Actions jobs from these repositories and refs publish with their OIDC token: no Mocco key stored in
            CI. Each gets a 15-minute upload session.
          </p>
        </div>
        {isAdmin && !isAdding ? (
          <Button
            variant="outline"
            className="shrink-0 text-sm"
            onClick={() => {
              setIsAdding(true);
            }}>
            Trust a repository
          </Button>
        ) : null}
      </div>
      {isAdding ? (
        <TrustPolicyForm
          workspaceId={workspaceId}
          projectId={projectId}
          app={app}
          isAdmin={isAdmin}
          channels={channels}
          onDone={() => {
            setIsAdding(false);
          }}
        />
      ) : null}
      <ul className="flex flex-col gap-2">
        {policies.map(policy => (
          <li key={policy.id} className="flex flex-col gap-1 rounded-xl border border-border px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-medium">{policy.repository}</span>
              {isAdmin ? (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Stop trusting ${policy.repository} ${policy.refPattern}`}
                  pending={removal.isPending && removal.variables.policyId === policy.id}
                  onClick={() => {
                    removal.mutate({ ...input, policyId: policy.id });
                  }}>
                  Remove
                </Button>
              ) : null}
            </div>
            <p className="font-mono text-xs text-muted-foreground">
              id {policy.repositoryId} · {policy.refPattern}
              {policy.workflowRef === null ? '' : ` · ${policy.workflowRef}`}
              {policy.environment === null ? '' : ` · env ${policy.environment}`}
            </p>
            <p className="text-xs text-muted-foreground">
              {policy.allowedChannels.length === 0
                ? 'Uploads only (no promotion).'
                : `May promote to ${policy.allowedChannels.join(', ')}.`}
            </p>
          </li>
        ))}
      </ul>
      {policies.length > 0 ? (
        <pre aria-label="Workflow step" className="overflow-x-auto rounded-lg bg-muted/40 p-3 font-mono text-xs">
          {workflowSnippet(app, firstChannel)}
        </pre>
      ) : null}
      {removal.error ? <p className="text-sm text-destructive">{errorMessage(removal.error)}</p> : null}
    </section>
  );
}

function HostedApp(props: AppProps) {
  const { workspaceId, projectId, app } = props;
  const channelsQuery = trpc.ota.hosting.channels.list.useQuery({ workspaceId, projectId, appId: app.id });
  const channels = channelsQuery.data?.channels ?? [];
  return (
    <div className="flex flex-col gap-8">
      <SetupCard app={app} channels={channels} />
      <Certificates {...props} />
      <Channels {...props} channels={channels} />
      <TrustPolicies {...props} channels={channels} />
      <Releases {...props} />
    </div>
  );
}

/**
 * The project's OTA hosting tab (ADR 0021): turn a React Native app into a Mocco-hosted
 * OTA app, register the certificate its builds embed, and manage its channels and their
 * protection. The selected OTA app is `?app=` in the URL.
 */
export default function OtaHosting({ workspaceId, projectId }: Props) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const { isAdmin } = useWorkspaceAdmin(workspaceId);
  const projectAppsQuery = trpc.project.listApps.useQuery({ workspaceId, projectId });
  const otaAppsQuery = trpc.ota.hosting.apps.list.useQuery({ workspaceId, projectId });
  const creation = trpc.ota.hosting.apps.create.useMutation({
    onSuccess: async result => {
      await utils.ota.hosting.apps.list.invalidate({ workspaceId, projectId });
      await router.push(Routes.projectOtaHosting(workspaceId, projectId, result.app.id), undefined, { shallow: true });
    },
  });

  if (projectAppsQuery.isPending || otaAppsQuery.isPending) {
    return <Spinner />;
  }
  const rnApps = (projectAppsQuery.data?.apps ?? []).filter(app => app.platform === AppPlatforms.reactNative);
  const otaApps = otaAppsQuery.data?.apps ?? [];
  if (rnApps.length === 0) {
    return (
      <Notice tone={Tones.neutral} title="No React Native app yet">
        Hosted OTA updates serve a project&apos;s React Native app.{' '}
        <Link href={Routes.project(workspaceId, projectId)} className="underline underline-offset-2">
          Add one on the project overview
        </Link>{' '}
        (platform React Native).
      </Notice>
    );
  }
  const requested = typeof router.query.app === 'string' ? router.query.app : undefined;
  const selected = otaApps.find(app => app.id === requested) ?? otaApps[0];
  const unhosted = rnApps.filter(app => otaApps.every(otaApp => otaApp.projectAppId !== app.id));

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">
        Serve OTA updates to the stock <span className="font-mono">expo-updates</span> client from Mocco, signed in your
        CI and promoted through approvals on protected channels.
      </p>
      {otaApps.length > 1 ? (
        <nav aria-label="OTA apps" className="flex flex-wrap gap-2">
          {otaApps.map(app => {
            const name = rnApps.find(projectApp => projectApp.id === app.projectAppId)?.name ?? app.id;
            return (
              <Link
                key={app.id}
                href={Routes.projectOtaHosting(workspaceId, projectId, app.id)}
                shallow
                aria-current={app.id === selected?.id ? 'page' : undefined}
                className="rounded-lg border border-border px-3 py-1.5 text-sm aria-[current=page]:border-foreground aria-[current=page]:bg-foreground aria-[current=page]:text-background">
                {name}
              </Link>
            );
          })}
        </nav>
      ) : null}
      {unhosted.map(app => (
        <div
          key={app.id}
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-border p-4">
          <span className="text-sm">
            <span className="font-medium">{app.name}</span>{' '}
            <span className="text-muted-foreground">doesn&apos;t use Mocco for OTA updates yet.</span>
          </span>
          <Button
            className="text-sm"
            pending={creation.isPending && creation.variables.projectAppId === app.id}
            onClick={() => {
              creation.mutate({ workspaceId, projectId, projectAppId: app.id });
            }}>
            Host OTA updates
          </Button>
        </div>
      ))}
      {creation.error ? <p className="text-sm text-destructive">{errorMessage(creation.error)}</p> : null}
      {selected === undefined ? null : (
        <HostedApp key={selected.id} workspaceId={workspaceId} projectId={projectId} app={selected} isAdmin={isAdmin} />
      )}
    </div>
  );
}
