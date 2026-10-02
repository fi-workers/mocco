import { FLAG_ENVIRONMENT_KEY_PATTERN, FLAG_KEY_PATTERN } from '@mocco/common/flags';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useState } from 'react';

import {
  Ago,
  errorMessage,
  inputClass,
  labelClass,
  Spinner,
  StatusBadge,
  Tones,
} from '@frontend/components/notifications/notification-ui';
import { Button } from '@frontend/components/ui/button';
import { Routes } from '@frontend/lib/routes';
import { trpc } from '@frontend/lib/trpc';

import type { ChangeDiffEntry, ChangesetDto, FlagConfigDto, FlagDto, FlagEnvironmentDto } from '@mocco/common/flags';

interface Props {
  workspaceId: string;
  projectId: string;
}

type FlagWithConfigs = FlagDto & { configs: FlagConfigDto[] };

function Environments({ workspaceId, projectId, environments }: Props & { environments: FlagEnvironmentDto[] }) {
  const utils = trpc.useUtils();
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const creation = trpc.flags.createEnvironment.useMutation({
    onSuccess: async () => {
      setKey('');
      setName('');
      await Promise.all([utils.flags.environments.invalidate(), utils.flags.list.invalidate()]);
    },
  });

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-medium">Environments</h2>
        <p className="text-xs text-muted-foreground">
          Each environment is its own ruleset, and each SDK key reads exactly one. The name is a label only: nothing in
          Mocco treats an environment called production differently.{' '}
          <Link href={Routes.guide('flags', 'quickstart')} className="underline underline-offset-2">
            Evaluate flags from your server
          </Link>
          .
        </p>
      </div>
      <ul className="flex flex-wrap gap-2">
        {environments.map(environment => (
          <li
            key={environment.id}
            className="flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm">
            <span className="font-medium">{environment.name}</span>
            <span className="font-mono text-xs text-muted-foreground">{environment.key}</span>
            <StatusBadge tone={Tones.neutral}>v{environment.currentVersion}</StatusBadge>
          </li>
        ))}
      </ul>
      <form
        aria-label="Create an environment"
        className="flex flex-wrap items-end gap-2"
        onSubmit={event => {
          event.preventDefault();
          creation.mutate({ workspaceId, projectId, key, name });
        }}>
        <label className={labelClass}>
          Key
          <input
            required
            value={key}
            pattern={FLAG_ENVIRONMENT_KEY_PATTERN.source}
            placeholder={environments.length === 0 ? 'production' : 'staging'}
            onChange={event => {
              setKey(event.target.value);
            }}
            className={`${inputClass} font-mono`}
          />
        </label>
        <label className={labelClass}>
          Name
          <input
            required
            value={name}
            placeholder={environments.length === 0 ? 'Production' : 'Staging'}
            onChange={event => {
              setName(event.target.value);
            }}
            className={inputClass}
          />
        </label>
        <Button
          type="submit"
          variant="outline"
          pending={creation.isPending}
          disabled={key === '' || name === ''}
          className="text-sm">
          Create environment
        </Button>
      </form>
      {creation.error ? <p className="text-sm text-destructive">{errorMessage(creation.error)}</p> : null}
    </section>
  );
}

/** One flag in one environment: its state and the toggle that applies a changeset at once. */
function FlagCell({
  workspaceId,
  projectId,
  flag,
  environment,
}: Props & { flag: FlagWithConfigs; environment: FlagEnvironmentDto }) {
  const utils = trpc.useUtils();
  const config = flag.configs.find(candidate => candidate.environmentId === environment.id);
  const change = trpc.flags.applyChangeset.useMutation({
    onSettled: async () => {
      await Promise.all([
        utils.flags.environments.invalidate(),
        utils.flags.list.invalidate(),
        utils.flags.history.invalidate(),
      ]);
    },
  });
  if (config === undefined) {
    return <td className="px-3 py-2 text-xs text-muted-foreground">—</td>;
  }
  const label = `${config.enabled ? 'Disable' : 'Enable'} ${flag.key} in ${environment.name}`;

  return (
    <td className="px-3 py-2">
      <div className="flex flex-col items-start gap-1">
        <Button
          variant={config.enabled ? 'default' : 'outline'}
          aria-label={label}
          aria-pressed={config.enabled}
          pending={change.isPending}
          className="h-7 px-2 text-xs"
          onClick={() => {
            change.mutate({
              workspaceId,
              projectId,
              environmentId: environment.id,
              baseVersion: environment.currentVersion,
              ops: [{ op: 'set_enabled', flagKey: flag.key, enabled: !config.enabled }],
            });
          }}>
          {config.enabled ? 'On' : 'Off'}
        </Button>
        {change.error ? <span className="text-xs text-destructive">{errorMessage(change.error)}</span> : null}
      </div>
    </td>
  );
}

function Flags({
  workspaceId,
  projectId,
  environments,
  flags,
}: Props & { environments: FlagEnvironmentDto[]; flags: FlagWithConfigs[] }) {
  const utils = trpc.useUtils();
  const [key, setKey] = useState('');
  const [description, setDescription] = useState('');
  const creation = trpc.flags.createBoolean.useMutation({
    onSuccess: async () => {
      setKey('');
      setDescription('');
      await Promise.all([utils.flags.environments.invalidate(), utils.flags.list.invalidate()]);
    },
  });

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-medium">Flags</h2>
        <p className="text-xs text-muted-foreground">
          A new flag is added to every environment switched off, so callers keep getting the default in their code until
          you turn it on. Each switch is applied at once and recorded in the environment’s history.
        </p>
      </div>
      {flags.length === 0 ? (
        <p className="text-sm text-muted-foreground">No flags yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Flag</th>
                {environments.map(environment => (
                  <th key={environment.id} className="px-3 py-2 font-medium">
                    {environment.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {flags.map(flag => (
                <tr key={flag.id} className="border-t border-border">
                  <td className="px-3 py-2">
                    <div className="font-mono">{flag.key}</div>
                    {flag.description ? <div className="text-xs text-muted-foreground">{flag.description}</div> : null}
                  </td>
                  {environments.map(environment => (
                    <FlagCell
                      key={environment.id}
                      workspaceId={workspaceId}
                      projectId={projectId}
                      flag={flag}
                      environment={environment}
                    />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <form
        aria-label="Create a flag"
        className="flex flex-wrap items-end gap-2"
        onSubmit={event => {
          event.preventDefault();
          creation.mutate({ workspaceId, projectId, key, description: description === '' ? null : description });
        }}>
        <label className={labelClass}>
          Key
          <input
            required
            value={key}
            pattern={FLAG_KEY_PATTERN.source}
            placeholder="new-checkout"
            onChange={event => {
              setKey(event.target.value);
            }}
            className={`${inputClass} font-mono`}
          />
        </label>
        <label className={labelClass}>
          Description
          <input
            value={description}
            placeholder="Optional"
            onChange={event => {
              setDescription(event.target.value);
            }}
            className={inputClass}
          />
        </label>
        <Button type="submit" variant="outline" pending={creation.isPending} disabled={key === ''} className="text-sm">
          Create boolean flag
        </Button>
      </form>
      {creation.error ? <p className="text-sm text-destructive">{errorMessage(creation.error)}</p> : null}
    </section>
  );
}

const fieldLabels: Record<string, string> = {
  enabled: 'on',
  killed: 'killed',
  defaultVariant: 'default variant',
  offVariant: 'off variant',
};

function describeDiff(entry: ChangeDiffEntry): string {
  const field = fieldLabels[entry.field] ?? entry.field;
  if (entry.before === null) {
    return `${entry.flagKey}: ${field} = ${String(entry.after)}`;
  }
  return `${entry.flagKey}: ${field} ${String(entry.before)} → ${String(entry.after)}`;
}

function ChangesetRow({ changeset }: { changeset: ChangesetDto }) {
  return (
    <li className="flex flex-col gap-1 rounded-lg border border-border px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={Tones.ok}>v{changeset.appliedVersion}</StatusBadge>
        <span className="text-xs text-muted-foreground">
          <Ago date={changeset.createdAt} />
        </span>
      </div>
      <ul className="font-mono text-xs">
        {changeset.diff.map(entry => (
          <li key={`${entry.flagKey}:${entry.field}`}>{describeDiff(entry)}</li>
        ))}
      </ul>
    </li>
  );
}

function History({ workspaceId, projectId, environments }: Props & { environments: FlagEnvironmentDto[] }) {
  const router = useRouter();
  const selectedId = typeof router.query.env === 'string' ? router.query.env : undefined;
  const environment = environments.find(candidate => candidate.id === selectedId) ?? environments[0];
  const historyQuery = trpc.flags.history.useQuery(
    { workspaceId, projectId, environmentId: environment?.id ?? '' },
    { enabled: environment !== undefined },
  );
  if (environment === undefined) {
    return null;
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-medium">History</h2>
        <nav aria-label="History environment" className="flex gap-1">
          {environments.map(candidate => (
            <Link
              key={candidate.id}
              href={Routes.projectFlags(workspaceId, projectId, candidate.id)}
              aria-current={candidate.id === environment.id ? 'page' : undefined}
              className={`rounded-md px-2 py-0.5 text-xs ${
                candidate.id === environment.id ? 'bg-muted font-medium' : 'text-muted-foreground'
              }`}>
              {candidate.name}
            </Link>
          ))}
        </nav>
      </div>
      {historyQuery.isLoading ? <Spinner /> : null}
      <ul className="flex flex-col gap-2">
        {(historyQuery.data?.changesets ?? []).map(changeset => (
          <ChangesetRow key={changeset.id} changeset={changeset} />
        ))}
      </ul>
    </section>
  );
}

/** The flags screen: environments, the flag × environment switches and the history. */
export default function FeatureFlags({ workspaceId, projectId }: Props) {
  const input = { workspaceId, projectId };
  const environmentsQuery = trpc.flags.environments.useQuery(input);
  const flagsQuery = trpc.flags.list.useQuery(input);
  if (environmentsQuery.isLoading || flagsQuery.isLoading) {
    return <Spinner />;
  }
  const error = environmentsQuery.error ?? flagsQuery.error;
  if (error) {
    return <p className="text-sm text-destructive">{errorMessage(error)}</p>;
  }
  const environments = environmentsQuery.data?.environments ?? [];
  const flags = flagsQuery.data?.flags ?? [];

  return (
    <div className="flex flex-col gap-8">
      <Environments workspaceId={workspaceId} projectId={projectId} environments={environments} />
      <Flags workspaceId={workspaceId} projectId={projectId} environments={environments} flags={flags} />
      <History workspaceId={workspaceId} projectId={projectId} environments={environments} />
    </div>
  );
}
