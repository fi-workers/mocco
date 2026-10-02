import { ApprovalDecisions, ApprovalStates, gateRequirementsSchema } from '@mocco/common/governance';
import { ChannelPolicyOutcomes, DEFAULT_SIGNING_KEY_ID, OtaHostingApprovalSubjects } from '@mocco/common/ota-hosting';
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
import type { OtaAppDto, OtaChannelDto } from '@mocco/common/ota-hosting';

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
      {notice === null ? null : <p className="text-xs text-muted-foreground">{notice}</p>}
      {change.error ? <p className="text-sm text-destructive">{errorMessage(change.error)}</p> : null}
      <PendingPolicyRequests {...props} />
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

function HostedApp(props: AppProps) {
  const { workspaceId, projectId, app } = props;
  const channelsQuery = trpc.ota.hosting.channels.list.useQuery({ workspaceId, projectId, appId: app.id });
  const channels = channelsQuery.data?.channels ?? [];
  return (
    <div className="flex flex-col gap-8">
      <SetupCard app={app} channels={channels} />
      <Certificates {...props} />
      <Channels {...props} channels={channels} />
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
