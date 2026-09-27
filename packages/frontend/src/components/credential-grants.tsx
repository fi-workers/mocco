import { OtaCredentialProviders } from '@mocco/common/ota';
import { useState } from 'react';

import {
  Ago,
  errorMessage,
  inputClass,
  labelClass,
  Notice,
  Spinner,
  Tones,
} from '@frontend/components/notifications/notification-ui';
import { Button } from '@frontend/components/ui/button';
import { trpc } from '@frontend/lib/trpc';

import type { CredentialGrantDto } from '@mocco/common/credential';

interface Props {
  workspaceId: string;
  isAdmin: boolean;
}

/** Provider ids the broker serves today, offered as suggestions (any id is accepted). */
const PROVIDER_SUGGESTIONS = Object.values(OtaCredentialProviders);
const DEFAULT_TTL_SECONDS = 900;
const MAX_TTL_SECONDS = 43_200;

/** Trimmed text of a form field. */
function clean(value: string): string {
  // eslint-disable-next-line sonarjs/null-dereference -- value is a string, never null
  return value.trim();
}

function AddGrantForm({
  workspaceId,
  repos,
}: {
  workspaceId: string;
  repos: readonly { id: string; label: string }[];
}) {
  const utils = trpc.useUtils();
  const [repoId, setRepoId] = useState(repos[0]?.id ?? '');
  const [pipeline, setPipeline] = useState('');
  const [gateName, setGateName] = useState('');
  const [provider, setProvider] = useState('');
  const [role, setRole] = useState('');
  const [maxTtlSeconds, setMaxTtlSeconds] = useState(DEFAULT_TTL_SECONDS);
  const creation = trpc.credentialGrant.create.useMutation({
    onSuccess: async () => {
      setPipeline('');
      setGateName('');
      setRole('');
      await utils.credentialGrant.list.invalidate({ workspaceId });
    },
  });
  const values = { pipeline: clean(pipeline), gateName: clean(gateName), provider: clean(provider), role: clean(role) };
  const isComplete = repoId !== '' && Object.values(values).every(value => value !== '');

  return (
    <form
      aria-label="Add a credential release"
      className="flex flex-col gap-3 rounded-xl bg-muted/40 p-4"
      onSubmit={event => {
        event.preventDefault();
        creation.mutate({ workspaceId, repoId, maxTtlSeconds, ...values });
      }}>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className={labelClass}>
          Repository
          <select
            value={repoId}
            onChange={event => {
              setRepoId(event.target.value);
            }}
            className={inputClass}>
            {repos.map(repo => (
              <option key={repo.id} value={repo.id}>
                {repo.label}
              </option>
            ))}
          </select>
        </label>
        <label className={labelClass}>
          Pipeline
          <input
            required
            value={pipeline}
            placeholder="ota-production"
            onChange={event => {
              setPipeline(event.target.value);
            }}
            className={`${inputClass} font-mono`}
          />
        </label>
        <label className={labelClass}>
          Gate
          <input
            required
            value={gateName}
            placeholder="prod"
            onChange={event => {
              setGateName(event.target.value);
            }}
            className={`${inputClass} font-mono`}
          />
        </label>
        <label className={labelClass}>
          Provider
          <input
            required
            list="credential-provider-suggestions"
            value={provider}
            placeholder="ota-eas"
            onChange={event => {
              setProvider(event.target.value);
            }}
            className={`${inputClass} font-mono`}
          />
          <datalist id="credential-provider-suggestions">
            {PROVIDER_SUGGESTIONS.map(id => (
              <option key={id} value={id} />
            ))}
          </datalist>
        </label>
        <label className={labelClass}>
          Role (for OTA: the token’s name)
          <input
            required
            value={role}
            placeholder="acme-production"
            onChange={event => {
              setRole(event.target.value);
            }}
            className={`${inputClass} font-mono`}
          />
        </label>
        <label className={labelClass}>
          Max ttl (seconds)
          <input
            type="number"
            min={60}
            max={MAX_TTL_SECONDS}
            value={maxTtlSeconds}
            onChange={event => {
              setMaxTtlSeconds(Math.min(MAX_TTL_SECONDS, Math.max(60, Math.trunc(Number(event.target.value)) || 60)));
            }}
            className={inputClass}
          />
        </label>
      </div>
      {creation.error ? <p className="text-sm text-destructive">{errorMessage(creation.error)}</p> : null}
      <Button type="submit" pending={creation.isPending} disabled={!isComplete} className="w-fit text-sm">
        Add release
      </Button>
    </form>
  );
}

function GrantRow({
  workspaceId,
  grant,
  repoName,
  isAdmin,
}: {
  workspaceId: string;
  grant: CredentialGrantDto;
  repoName: string;
  isAdmin: boolean;
}) {
  const utils = trpc.useUtils();
  const removal = trpc.credentialGrant.delete.useMutation({
    onSuccess: async () => {
      await utils.credentialGrant.list.invalidate({ workspaceId });
    },
  });
  return (
    <li className="flex flex-col gap-1 rounded-lg border border-border px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-sm">
          {grant.provider} / {grant.role}
        </span>
        {isAdmin ? (
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Remove release of ${grant.provider} / ${grant.role} to ${repoName} ${grant.pipeline} gate ${grant.gateName}`}
            pending={removal.isPending}
            onClick={() => {
              removal.mutate({ workspaceId, grantId: grant.id });
            }}>
            Remove
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        To <span className="font-mono">{repoName}</span> · pipeline <span className="font-mono">{grant.pipeline}</span>{' '}
        · after gate <span className="font-mono">{grant.gateName}</span> · at most {grant.maxTtlSeconds}s · added{' '}
        <Ago date={grant.createdAt} />
      </p>
      {removal.error ? <p className="text-sm text-destructive">{errorMessage(removal.error)}</p> : null}
    </li>
  );
}

/**
 * The credential allowlist: which pipeline gate may receive which credential. The broker
 * releases a credential only to a step whose run resumed the named gate, only if a grant
 * here matches, and never for longer than its max ttl. Owners and admins edit it; members
 * read it (the server enforces this).
 */
export default function CredentialGrants({ workspaceId, isAdmin }: Props) {
  const grantsQuery = trpc.credentialGrant.list.useQuery({ workspaceId });
  // Grants point at registered repos, which come from the GitHub integration.
  const reposQuery = trpc.integration.repos.useQuery({ workspaceId }, { retry: false });
  const repos = (reposQuery.data?.repos ?? []).map(repo => ({ id: repo.id, label: `${repo.owner}/${repo.name}` }));
  const labels = new Map(repos.map(repo => [repo.id, repo.label]));
  const grants = grantsQuery.data?.grants ?? [];
  const [isAdding, setIsAdding] = useState(false);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold tracking-tight">Credential releases</h2>
          <p className="text-sm text-muted-foreground">
            Which pipeline gate may receive which credential. A step gets a credential only after its run passes the
            gate, and only for the time allowed here.
          </p>
        </div>
        {isAdmin && repos.length > 0 ? (
          <Button
            variant={isAdding ? 'ghost' : 'outline'}
            className="shrink-0 text-sm"
            onClick={() => {
              setIsAdding(value => !value);
            }}>
            {isAdding ? 'Close' : 'Add release'}
          </Button>
        ) : null}
      </div>
      {isAdmin && reposQuery.isError ? (
        <Notice tone={Tones.neutral} title="No repositories yet">
          Connect GitHub on the workspace overview to register repositories first.
        </Notice>
      ) : null}
      {isAdding && repos.length > 0 ? <AddGrantForm workspaceId={workspaceId} repos={repos} /> : null}
      {grantsQuery.isPending ? <Spinner /> : null}
      {grantsQuery.isSuccess && grants.length === 0 ? (
        <p className="text-sm text-muted-foreground">No credential is released to any pipeline yet.</p>
      ) : null}
      <ul className="flex flex-col gap-2">
        {grants.map(grant => (
          <GrantRow
            key={grant.id}
            workspaceId={workspaceId}
            grant={grant}
            repoName={labels.get(grant.repoId) ?? grant.repoId}
            isAdmin={isAdmin}
          />
        ))}
      </ul>
    </section>
  );
}
