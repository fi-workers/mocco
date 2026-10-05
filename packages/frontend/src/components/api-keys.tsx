import { ApiKeyKinds, ApiScopes, PUBLISHABLE_SCOPES } from '@mocco/common/apikey';
import Link from 'next/link';
import { useState } from 'react';

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
import { Button } from '@frontend/components/ui/button';
import { Routes } from '@frontend/lib/routes';
import { trpc } from '@frontend/lib/trpc';
import { useWorkspaceAdmin } from '@frontend/lib/use-workspace-admin';

import type { ApiKeyDto, ApiKeyKind, ApiScope } from '@mocco/common/apikey';

interface Props {
  workspaceId: string;
  projectId: string;
}

const kindLabels: Record<ApiKeyKind, string> = {
  [ApiKeyKinds.publishable]: 'Publishable',
  [ApiKeyKinds.secret]: 'Secret',
};

const kindHints: Record<ApiKeyKind, string> = {
  [ApiKeyKinds.publishable]: "For web and React Native apps. Safe to ship in the app; can't change anything.",
  [ApiKeyKinds.secret]: "For servers and CI. Keep it out of apps and browsers: it's refused from a web page.",
};

const scopeLabels: Record<ApiScope, string> = {
  [ApiScopes.runsRead]: 'runs:read — watch deploys (read-only; approving needs a person)',
  [ApiScopes.otaRead]: 'ota:read — check for OTA updates',
  [ApiScopes.otaWrite]: 'ota:write — upload and publish OTA updates',
  [ApiScopes.flagsRead]: 'flags:read — evaluate feature flags',
  [ApiScopes.flagsWrite]: 'flags:write — change feature flags',
  [ApiScopes.messengerChat]: 'messenger:chat — let signed-in users contact you',
  [ApiScopes.helpRead]: 'help:read — search your published help center',
  [ApiScopes.statusWrite]: 'status:write — manage monitors, incidents and maintenance, and run a check now',
  [ApiScopes.statusRead]: 'status:read — read monitors, incidents, maintenance and components',
};

const ALL_SCOPES = Object.values(ApiScopes);

/** The scopes a new key of `kind` may hold. */
const scopesFor = (kind: ApiKeyKind): readonly ApiScope[] =>
  kind === ApiKeyKinds.publishable ? PUBLISHABLE_SCOPES : ALL_SCOPES;

/** The project's flag environments, for binding a flags:read key; empty while loading or
 * when the flags product is off. */
function useFlagEnvironments(workspaceId: string, projectId: string, isEnabled: boolean) {
  const query = trpc.flags.environments.useQuery({ workspaceId, projectId }, { enabled: isEnabled, retry: false });
  return { environments: query.data?.environments ?? [], error: query.error };
}

function CreatedKey({ token, onDone }: { token: string; onDone: () => void }) {
  return (
    <div className="flex flex-col gap-2">
      <Notice tone={Tones.warn} title="Copy the key now">
        This is the only time it is shown. Mocco stores only a hash, so a lost key can&apos;t be recovered; revoke it
        and create a new one.
      </Notice>
      <CopyField label="New API key" value={token} />
      <Button variant="outline" className="w-fit text-sm" onClick={onDone}>
        Done
      </Button>
    </div>
  );
}

function CreateKeyForm({ workspaceId, projectId, onCreated }: Props & { onCreated: (token: string) => void }) {
  const utils = trpc.useUtils();
  const [kind, setKind] = useState<ApiKeyKind>(ApiKeyKinds.secret);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ApiScope[]>([]);
  const [environmentId, setEnvironmentId] = useState('');
  const creation = trpc.apiKey.create.useMutation({
    onSuccess: async result => {
      await utils.apiKey.list.invalidate({ workspaceId, projectId });
      onCreated(result.token);
    },
  });
  const toggleScope = (scope: ApiScope, isOn: boolean) => {
    setScopes(previous => (isOn ? [...previous, scope] : previous.filter(other => other !== scope)));
  };
  const allowed = scopesFor(kind);
  const chosen = scopes.filter(scope => allowed.includes(scope));
  // eslint-disable-next-line sonarjs/null-dereference -- name is a useState<string>, never null
  const trimmedName = name.trim();
  const isEnvironmentNeeded = chosen.includes(ApiScopes.flagsRead);
  const { environments, error: environmentsError } = useFlagEnvironments(workspaceId, projectId, isEnvironmentNeeded);

  return (
    <form
      aria-label="Create an API key"
      className="flex flex-col gap-3 rounded-xl bg-muted/40 p-4"
      onSubmit={event => {
        event.preventDefault();
        creation.mutate({
          workspaceId,
          projectId,
          kind,
          name: trimmedName,
          scopes: chosen,
          flagEnvironmentId: isEnvironmentNeeded ? environmentId : null,
        });
      }}>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-xs font-medium text-muted-foreground">Kind</legend>
        {Object.values(ApiKeyKinds).map(value => (
          <label key={value} className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="kind"
              className="mt-1"
              aria-label={kindLabels[value]}
              checked={kind === value}
              onChange={() => {
                setKind(value);
              }}
            />
            <span>
              <span className="font-medium">{kindLabels[value]}</span>
              <span className="block text-xs text-muted-foreground">{kindHints[value]}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <label className={labelClass}>
        Name
        <input
          required
          maxLength={80}
          value={name}
          placeholder={kind === ApiKeyKinds.secret ? 'CI publishing' : 'Acme web'}
          onChange={event => {
            setName(event.target.value);
          }}
          className={inputClass}
        />
      </label>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1 text-xs font-medium text-muted-foreground">Scopes</legend>
        {allowed.map(scope => (
          <label key={scope} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={chosen.includes(scope)}
              onChange={event => {
                toggleScope(scope, event.target.checked);
              }}
            />
            <span className="font-mono text-xs">{scopeLabels[scope]}</span>
          </label>
        ))}
      </fieldset>
      {isEnvironmentNeeded ? (
        <label className={labelClass}>
          Flag environment
          <select
            required
            aria-describedby="flag-environment-hint"
            value={environmentId}
            onChange={event => {
              setEnvironmentId(event.target.value);
            }}
            className={inputClass}>
            <option value="" disabled>
              Choose the environment this key reads
            </option>
            {environments.map(environment => (
              <option key={environment.id} value={environment.id}>
                {environment.name} ({environment.key})
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {isEnvironmentNeeded ? (
        <p id="flag-environment-hint" className="-mt-2 text-xs text-muted-foreground">
          A flags key reads exactly one environment&apos;s flags. Create another key for each environment.
          {environmentsError ? <span className="block text-destructive">{errorMessage(environmentsError)}</span> : null}
        </p>
      ) : null}
      {kind === ApiKeyKinds.publishable ? (
        <p className="text-xs text-muted-foreground">
          From a browser, the key works only on the web origins of the project&apos;s apps.{' '}
          <Link href={Routes.project(workspaceId, projectId)} className="underline underline-offset-2">
            Set them on the project overview
          </Link>
          .
        </p>
      ) : null}
      {creation.error ? <p className="text-sm text-destructive">{errorMessage(creation.error)}</p> : null}
      <Button
        type="submit"
        pending={creation.isPending}
        disabled={trimmedName === '' || chosen.length === 0 || (isEnvironmentNeeded && environmentId === '')}
        className="w-fit text-sm">
        Create key
      </Button>
    </form>
  );
}

function KeyRow({
  workspaceId,
  projectId,
  apiKey,
  isAdmin,
  environmentName,
}: Props & { apiKey: ApiKeyDto; isAdmin: boolean; environmentName: string | undefined }) {
  const utils = trpc.useUtils();
  const [isConfirming, setIsConfirming] = useState(false);
  const revocation = trpc.apiKey.revoke.useMutation({
    onSuccess: async () => {
      setIsConfirming(false);
      await utils.apiKey.list.invalidate({ workspaceId, projectId });
    },
  });
  const isRevoked = apiKey.revokedAt !== null;
  // The time this row first rendered: enough to label a key that has expired.
  const [renderedAt] = useState(() => Date.now());
  const isExpired = !isRevoked && apiKey.expiresAt !== null && apiKey.expiresAt.getTime() <= renderedAt;

  return (
    <li className="flex flex-col gap-2 rounded-xl border border-border px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{apiKey.name}</span>
          <StatusBadge tone={apiKey.kind === ApiKeyKinds.secret ? Tones.warn : Tones.neutral}>
            {kindLabels[apiKey.kind]}
          </StatusBadge>
          {isRevoked ? <StatusBadge tone={Tones.danger}>Revoked</StatusBadge> : null}
          {isExpired ? <StatusBadge tone={Tones.danger}>Expired</StatusBadge> : null}
        </div>
        {isAdmin && !isRevoked && !isConfirming ? (
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Revoke ${apiKey.name}`}
            onClick={() => {
              setIsConfirming(true);
            }}>
            Revoke
          </Button>
        ) : null}
      </div>
      <p className="font-mono text-xs text-muted-foreground">
        {apiKey.hint} · {apiKey.scopes.join(', ')}
        {apiKey.flagEnvironmentId === null ? null : ` · reads ${environmentName ?? 'a flag environment'}`}
      </p>
      <p className="text-xs text-muted-foreground">
        Created <Ago date={apiKey.createdAt} /> ·{' '}
        {apiKey.lastUsedAt === null ? (
          'never used'
        ) : (
          <>
            last used <Ago date={apiKey.lastUsedAt} />
          </>
        )}
        {apiKey.revokedAt === null ? null : (
          <>
            {' '}
            · revoked <Ago date={apiKey.revokedAt} />
          </>
        )}
      </p>
      {isConfirming ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
          <span>Revoke {apiKey.name}? Calls with it fail at once.</span>
          <Button
            variant="destructive"
            size="sm"
            pending={revocation.isPending}
            onClick={() => {
              revocation.mutate({ workspaceId, projectId, keyId: apiKey.id });
            }}>
            Revoke key
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setIsConfirming(false);
            }}>
            Cancel
          </Button>
        </div>
      ) : null}
      {revocation.error ? <p className="text-sm text-destructive">{errorMessage(revocation.error)}</p> : null}
    </li>
  );
}

/**
 * The project's API keys for the public /v1 API (ADR 0017). Owners and admins create and
 * revoke keys; members see them read-only. A new key's token is shown once.
 */
export default function ApiKeys({ workspaceId, projectId }: Props) {
  const { isAdmin } = useWorkspaceAdmin(workspaceId);
  const keysQuery = trpc.apiKey.list.useQuery({ workspaceId, projectId });
  const [isCreating, setIsCreating] = useState(false);
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const keys = keysQuery.data?.keys ?? [];
  const { environments } = useFlagEnvironments(
    workspaceId,
    projectId,
    keys.some(apiKey => apiKey.flagEnvironmentId !== null),
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Keys for Mocco&apos;s public API and SDKs. Send one as{' '}
          <span className="font-mono">Authorization: Bearer</span>.
          {isAdmin ? '' : ' You have read-only access; owners and admins manage keys.'}
        </p>
        {isAdmin && !isCreating && createdToken === null ? (
          <Button
            variant="outline"
            className="shrink-0 text-sm"
            onClick={() => {
              setIsCreating(true);
            }}>
            Create key
          </Button>
        ) : null}
      </div>
      {createdToken === null ? null : (
        <CreatedKey
          token={createdToken}
          onDone={() => {
            setCreatedToken(null);
          }}
        />
      )}
      {isCreating ? (
        <CreateKeyForm
          workspaceId={workspaceId}
          projectId={projectId}
          onCreated={token => {
            setIsCreating(false);
            setCreatedToken(token);
          }}
        />
      ) : null}
      {keysQuery.isPending ? <Spinner /> : null}
      {keysQuery.isSuccess && keys.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          No API keys yet.
        </p>
      ) : null}
      <ul className="flex flex-col gap-2">
        {keys.map(apiKey => (
          <KeyRow
            key={apiKey.id}
            workspaceId={workspaceId}
            projectId={projectId}
            apiKey={apiKey}
            isAdmin={isAdmin}
            environmentName={environments.find(environment => environment.id === apiKey.flagEnvironmentId)?.name}
          />
        ))}
      </ul>
    </div>
  );
}
