import { OTA_CREDENTIAL_NAME_PATTERN, OtaTools } from '@mocco/common/ota';
import Link from 'next/link';
import { useState } from 'react';

import {
  Ago,
  CopyField,
  daysSince,
  errorMessage,
  inputClass,
  labelClass,
  Notice,
  Spinner,
  StatusBadge,
  Tones,
} from '@frontend/components/notifications/notification-ui';
import { Button } from '@frontend/components/ui/button';
import { Routes } from '@frontend/lib/routes';
import { trpc } from '@frontend/lib/trpc';

import type { CredentialGrantDto } from '@mocco/common/credential';
import type { OtaExternalCredentialDto, OtaTool } from '@mocco/common/ota';

interface Props {
  workspaceId: string;
  projectId: string;
}

const toolLabels: Record<OtaTool, string> = {
  [OtaTools.eas]: 'EAS Update',
  [OtaTools.codepush]: 'CodePush (hosted)',
  [OtaTools.hotUpdater]: 'hot-updater',
  [OtaTools.generic]: 'Other tool',
};

/** What the publishing workflow exports the released token as, where the tool's CLI
 * reads a fixed variable (CodePush CLIs take `--accessKey`; hot-updater reads its
 * storage plugin's own variables). */
const toolEnvironment: Partial<Record<OtaTool, string>> = {
  [OtaTools.eas]: 'EXPO_TOKEN',
};

/** The customer guide for each tool. */
const toolGuides: Record<OtaTool, string> = {
  [OtaTools.eas]: 'gate-eas-update',
  [OtaTools.codepush]: 'gate-codepush',
  [OtaTools.hotUpdater]: 'gate-hot-updater',
  [OtaTools.generic]: 'pipeline',
};

/** A static token older than this gets a rotation reminder. */
const ROTATE_AFTER_DAYS = 90;

function CreateTokenForm({ workspaceId, projectId }: Props) {
  const utils = trpc.useUtils();
  const [tool, setTool] = useState<OtaTool>(OtaTools.eas);
  const [name, setName] = useState('');
  const [secret, setSecret] = useState('');
  const creation = trpc.ota.externalCredential.create.useMutation({
    onSuccess: async () => {
      setName('');
      setSecret('');
      await utils.ota.externalCredential.list.invalidate({ workspaceId, projectId });
    },
  });
  const isNameValid = OTA_CREDENTIAL_NAME_PATTERN.test(name);

  return (
    <form
      aria-label="Add a publishing token"
      className="flex flex-col gap-3 rounded-xl border border-border p-4"
      onSubmit={event => {
        event.preventDefault();
        creation.mutate({ workspaceId, projectId, tool, name, secret });
      }}>
      <div>
        <h2 className="text-sm font-medium">Add a publishing token</h2>
        <p className="text-xs text-muted-foreground">
          The token is encrypted at rest and never shown again. Scope it as narrowly as your tool allows.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={labelClass}>
          Tool
          <select
            value={tool}
            onChange={event => {
              setTool(event.target.value as OtaTool);
            }}
            className={inputClass}>
            {Object.values(OtaTools).map(value => (
              <option key={value} value={value}>
                {toolLabels[value]}
              </option>
            ))}
          </select>
        </label>
        <label className={labelClass}>
          <span>
            Name (the <span className="font-mono">role</span> in .mocco.yml)
          </span>
          <input
            required
            maxLength={64}
            value={name}
            placeholder="acme-production"
            autoComplete="off"
            onChange={event => {
              setName(event.target.value);
            }}
            className={`${inputClass} font-mono`}
          />
        </label>
      </div>
      <label className={labelClass}>
        Token
        <input
          required
          type="password"
          maxLength={8192}
          value={secret}
          autoComplete="off"
          onChange={event => {
            setSecret(event.target.value);
          }}
          className={`${inputClass} font-mono`}
        />
      </label>
      {name !== '' && !isNameValid ? (
        <p className="text-sm text-destructive">
          Use lowercase letters, digits and inner hyphens, like acme-production.
        </p>
      ) : null}
      {creation.error ? <p className="text-sm text-destructive">{errorMessage(creation.error)}</p> : null}
      <Button
        type="submit"
        pending={creation.isPending}
        disabled={!isNameValid || secret === ''}
        className="w-fit text-sm">
        Add token
      </Button>
    </form>
  );
}

function RotateForm({
  workspaceId,
  projectId,
  credential,
  onDone,
}: Props & { credential: OtaExternalCredentialDto; onDone: () => void }) {
  const utils = trpc.useUtils();
  const [secret, setSecret] = useState('');
  const rotation = trpc.ota.externalCredential.rotate.useMutation({
    onSuccess: async () => {
      await utils.ota.externalCredential.list.invalidate({ workspaceId, projectId });
      onDone();
    },
  });
  return (
    <form
      aria-label={`Rotate ${credential.name}`}
      className="flex flex-col gap-2 rounded-lg bg-muted/40 p-3"
      onSubmit={event => {
        event.preventDefault();
        rotation.mutate({ workspaceId, projectId, credentialId: credential.id, secret });
      }}>
      <label className={labelClass}>
        New token (revoke the old one in {toolLabels[credential.tool]} after this)
        <input
          required
          type="password"
          maxLength={8192}
          value={secret}
          autoComplete="off"
          onChange={event => {
            setSecret(event.target.value);
          }}
          className={`${inputClass} font-mono`}
        />
      </label>
      {rotation.error ? <p className="text-sm text-destructive">{errorMessage(rotation.error)}</p> : null}
      <div className="flex gap-2">
        <Button type="submit" pending={rotation.isPending} disabled={secret === ''} className="text-sm">
          Save new token
        </Button>
        <Button variant="ghost" className="text-sm" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function DeleteConfirm({
  workspaceId,
  projectId,
  credential,
  onDone,
}: Props & { credential: OtaExternalCredentialDto; onDone: () => void }) {
  const utils = trpc.useUtils();
  const removal = trpc.ota.externalCredential.delete.useMutation({
    onSuccess: async () => {
      await utils.ota.externalCredential.list.invalidate({ workspaceId, projectId });
    },
  });
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
      <p>
        Delete <span className="font-mono">{credential.name}</span>? Pipelines that request it are denied from then on.
        Revoke the token in {toolLabels[credential.tool]} too.
      </p>
      {removal.error ? <p className="text-destructive">{errorMessage(removal.error)}</p> : null}
      <div className="flex gap-2">
        <Button
          variant="destructive"
          className="text-sm"
          pending={removal.isPending}
          onClick={() => {
            removal.mutate({ workspaceId, projectId, credentialId: credential.id });
          }}>
          Delete token
        </Button>
        <Button variant="ghost" className="text-sm" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

const Modes = { view: 'view', rotate: 'rotate', delete: 'delete' } as const;
type Mode = (typeof Modes)[keyof typeof Modes];

function TokenCard({
  workspaceId,
  projectId,
  credential,
  grants,
  repoName,
  nameOf,
}: Props & {
  credential: OtaExternalCredentialDto;
  grants: readonly CredentialGrantDto[];
  repoName: (repoId: string) => string;
  nameOf: (userId: string | null) => string;
}) {
  const [mode, setMode] = useState<Mode>(Modes.view);
  const age = daysSince(credential.rotatedAt ?? credential.createdAt);
  const environment = toolEnvironment[credential.tool];
  const snippet = `credential: { provider: ${credential.provider}, role: ${credential.name}, ttl: 900, gate: prod }`;

  return (
    <li className="flex flex-col gap-3 rounded-xl border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="font-mono text-sm font-medium">{credential.name}</span>
          <StatusBadge tone={Tones.neutral}>{toolLabels[credential.tool]}</StatusBadge>
          {age >= ROTATE_AFTER_DAYS ? <StatusBadge tone={Tones.warn}>{age} days old — rotate</StatusBadge> : null}
        </div>
        {mode === Modes.view ? (
          <div className="flex gap-1">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setMode(Modes.rotate);
              }}>
              Rotate
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setMode(Modes.delete);
              }}>
              Delete
            </Button>
          </div>
        ) : null}
      </div>
      <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
        <dt className="text-muted-foreground">Fingerprint</dt>
        <dd className="font-mono">{credential.secretFingerprint}</dd>
        <dt className="text-muted-foreground">Provider</dt>
        <dd className="font-mono">{credential.provider}</dd>
        <dt className="text-muted-foreground">Added</dt>
        <dd>
          {nameOf(credential.createdByUserId)} · <Ago date={credential.createdAt} />
          {credential.rotatedAt === null ? null : (
            <>
              {' '}
              · rotated <Ago date={credential.rotatedAt} />
            </>
          )}
        </dd>
        <dt className="text-muted-foreground">Released to</dt>
        <dd>
          {grants.length === 0 ? (
            <>
              No pipeline yet. A workspace owner or admin adds a release for this provider and role under{' '}
              <Link href={Routes.workspaceAccess(workspaceId)} className="underline underline-offset-2">
                Access
              </Link>
              .
            </>
          ) : (
            grants
              .map(
                grant =>
                  `${repoName(grant.repoId)} · ${grant.pipeline} · gate ${grant.gateName} (≤ ${grant.maxTtlSeconds}s)`,
              )
              .join('; ')
          )}
        </dd>
      </dl>
      <div className="flex flex-col gap-1">
        <p className="text-xs text-muted-foreground">
          In the publishing step of <span className="font-mono">.mocco.yml</span>, behind your gate
          {environment === undefined ? '' : ` (the workflow exports it as ${environment})`}:
        </p>
        <CopyField label={`.mocco.yml credential for ${credential.name}`} value={snippet} />
        <Link
          href={Routes.otaGuide(toolGuides[credential.tool])}
          className="w-fit text-xs underline underline-offset-2">
          Publishing with {toolLabels[credential.tool]}
        </Link>
      </div>
      {mode === Modes.rotate ? (
        <RotateForm
          workspaceId={workspaceId}
          projectId={projectId}
          credential={credential}
          onDone={() => {
            setMode(Modes.view);
          }}
        />
      ) : null}
      {mode === Modes.delete ? (
        <DeleteConfirm
          workspaceId={workspaceId}
          projectId={projectId}
          credential={credential}
          onDone={() => {
            setMode(Modes.view);
          }}
        />
      ) : null}
    </li>
  );
}

/**
 * The project's OTA tokens: the publishing tokens of the team's existing OTA tool (EAS
 * Update, hosted CodePush, hot-updater). Mocco keeps each one sealed and hands it only to
 * a pipeline step that reached a resumed gate, through the credential broker. Tokens are
 * write-only: the list shows a fingerprint, and replacing one is a rotation.
 */
export default function PublishingTokens({ workspaceId, projectId }: Props) {
  const credentialsQuery = trpc.ota.externalCredential.list.useQuery({ workspaceId, projectId });
  const grantsQuery = trpc.credentialGrant.list.useQuery({ workspaceId });
  // Repo names come from the GitHub integration; without it grants show the repo id.
  const reposQuery = trpc.integration.repos.useQuery({ workspaceId }, { retry: false });
  const membersQuery = trpc.workspace.members.useQuery({ workspaceId });
  const repos = new Map((reposQuery.data?.repos ?? []).map(repo => [repo.id, `${repo.owner}/${repo.name}`]));
  const names = new Map((membersQuery.data?.members ?? []).map(member => [member.userId, member.user.name]));
  const repoName = (repoId: string) => repos.get(repoId) ?? repoId;
  const nameOf = (userId: string | null) => (userId === null ? 'Deleted user' : (names.get(userId) ?? 'Former member'));
  const credentials = credentialsQuery.data?.credentials ?? [];
  const grants = grantsQuery.data?.grants ?? [];

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">
        Keep publishing with your OTA tool. Mocco holds its publishing token and releases it only to a pipeline step
        that passed an approved gate, so nobody can push an update without the approval. The token itself is static: the
        ttl limits Mocco’s grant, not the token, so publish from GitHub-hosted runners and rotate it on a schedule.{' '}
        <Link href={Routes.otaGuide('pipeline')} className="underline underline-offset-2">
          Read the setup guide
        </Link>
      </p>
      {credentialsQuery.isPending ? <Spinner /> : null}
      {credentialsQuery.isError ? (
        <Notice tone={Tones.danger} title="Couldn’t load the tokens">
          {credentialsQuery.error.message}
        </Notice>
      ) : null}
      {credentialsQuery.isSuccess && credentials.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          No tokens yet.
        </p>
      ) : null}
      <ul className="flex flex-col gap-3">
        {credentials.map(credential => (
          <TokenCard
            key={credential.id}
            workspaceId={workspaceId}
            projectId={projectId}
            credential={credential}
            grants={grants.filter(grant => grant.provider === credential.provider && grant.role === credential.name)}
            repoName={repoName}
            nameOf={nameOf}
          />
        ))}
      </ul>
      <CreateTokenForm workspaceId={workspaceId} projectId={projectId} />
    </div>
  );
}
