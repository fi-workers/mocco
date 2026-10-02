import { FLAG_ENVIRONMENT_KEY_PATTERN, FLAG_KEY_PATTERN, FlagTypes } from '@mocco/common/flags';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useState } from 'react';

import ChangesetRow from '@frontend/components/flags/changeset-row';
import Protection from '@frontend/components/flags/protection';
import Segments from '@frontend/components/flags/segments';
import { StaleBadges, StaleSummary } from '@frontend/components/flags/stale';
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

import type { Tone } from '@frontend/components/notifications/notification-ui';
import type {
  FlagConfigDto,
  FlagDto,
  FlagEnvironmentDto,
  FlagFileSyncDto,
  FlagType,
  StaleFindingDto,
  TimelineRunDto,
} from '@mocco/common/flags';

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
            {environment.changeGate === null ? null : <StatusBadge tone={Tones.warn}>Protected</StatusBadge>}
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
  const [isSentForApproval, setIsSentForApproval] = useState(false);
  const change = trpc.flags.applyChangeset.useMutation({
    onSuccess: result => {
      setIsSentForApproval(result.outcome === 'pending_approval');
    },
    onSettled: async () => {
      await Promise.all([
        utils.flags.environments.invalidate(),
        utils.flags.list.invalidate(),
        utils.flags.timeline.invalidate(),
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
          // A repo-managed flag changes through .mocco/flags.yml, not here.
          disabled={flag.managedBy === 'repo'}
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
        {config.killed ? <StatusBadge tone={Tones.danger}>Killed</StatusBadge> : null}
        {isSentForApproval ? <span className="text-xs text-muted-foreground">Sent for approval</span> : null}
        {change.error ? <span className="text-xs text-destructive">{errorMessage(change.error)}</span> : null}
      </div>
    </td>
  );
}

const variantPlaceholders: Record<Exclude<FlagType, 'boolean'>, string> = {
  [FlagTypes.string]: '{ "short": "Pay", "long": "Pay securely" }',
  [FlagTypes.number]: '{ "small": 10, "large": 100 }',
  [FlagTypes.json]: '{ "a": { "columns": 2 }, "b": { "columns": 3 } }',
};

/** Create a boolean flag, or a string, number or JSON flag with its variants. */
function CreateFlagForm({ workspaceId, projectId }: Props) {
  const utils = trpc.useUtils();
  const [key, setKey] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<FlagType>(FlagTypes.boolean);
  const [variantsText, setVariantsText] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const onCreated = async () => {
    setKey('');
    setDescription('');
    setVariantsText('');
    await Promise.all([utils.flags.environments.invalidate(), utils.flags.list.invalidate()]);
  };
  const booleanCreation = trpc.flags.createBoolean.useMutation({ onSuccess: onCreated });
  const typedCreation = trpc.flags.create.useMutation({ onSuccess: onCreated });
  const error = parseError ?? errorMessage(booleanCreation.error ?? typedCreation.error);
  // eslint-disable-next-line sonarjs/null-dereference -- a useState<string>, never null
  const hasVariants = variantsText.trim() !== '';

  return (
    <form
      aria-label="Create a flag"
      className="flex flex-col gap-2"
      onSubmit={event => {
        event.preventDefault();
        const flagDescription = description === '' ? null : description;
        if (type === FlagTypes.boolean) {
          booleanCreation.mutate({ workspaceId, projectId, key, description: flagDescription });
          return;
        }
        let variants: Record<string, unknown>;
        try {
          variants = JSON.parse(variantsText) as Record<string, unknown>;
        } catch {
          setParseError('Variants must be a JSON object of name → value.');
          return;
        }
        setParseError(null);
        // The first variant is the default (and what a kill serves) until changed.
        const [first = ''] = Object.keys(variants);
        typedCreation.mutate({
          workspaceId,
          projectId,
          flag: { key, type, variants, defaultVariant: first, offVariant: first, description: flagDescription },
        });
      }}>
      <div className="flex flex-wrap items-end gap-2">
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
          Type
          <select
            value={type}
            className={inputClass}
            onChange={event => {
              setType(event.target.value as FlagType);
            }}>
            {Object.values(FlagTypes).map(value => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
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
        <Button
          type="submit"
          variant="outline"
          pending={booleanCreation.isPending || typedCreation.isPending}
          disabled={key === '' || (type !== FlagTypes.boolean && !hasVariants)}
          className="text-sm">
          Create {type} flag
        </Button>
      </div>
      {type === FlagTypes.boolean ? null : (
        <label className={labelClass}>
          Variants (JSON: name → value; the first is the default and the kill value)
          <textarea
            rows={3}
            value={variantsText}
            placeholder={variantPlaceholders[type]}
            className={`${inputClass} h-auto py-1.5 font-mono text-xs`}
            onChange={event => {
              setVariantsText(event.target.value);
            }}
          />
        </label>
      )}
      {error === null ? null : <p className="text-sm text-destructive">{error}</p>}
    </form>
  );
}

function Flags({
  workspaceId,
  projectId,
  environments,
  flags,
  stale,
}: Props & { environments: FlagEnvironmentDto[]; flags: FlagWithConfigs[]; stale: readonly StaleFindingDto[] }) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-medium">Flags</h2>
        <p className="text-xs text-muted-foreground">
          A new flag is added to every environment switched off, so callers keep getting the default in their code until
          you turn it on. Each switch is applied at once and recorded in the environment’s history.
        </p>
      </div>
      <StaleSummary findings={stale} />
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
                    <div className="flex items-center gap-2">
                      <Link
                        href={Routes.projectFlag(workspaceId, projectId, flag.key)}
                        className="font-mono underline-offset-2 hover:underline">
                        {flag.key}
                      </Link>
                      {flag.type === FlagTypes.boolean ? null : (
                        <StatusBadge tone={Tones.neutral}>{flag.type}</StatusBadge>
                      )}
                      {flag.managedBy === 'repo' ? <StatusBadge tone={Tones.neutral}>From repo</StatusBadge> : null}
                      <StaleBadges findings={stale.filter(finding => finding.flagKey === flag.key)} />
                    </div>
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
      <CreateFlagForm workspaceId={workspaceId} projectId={projectId} />
    </section>
  );
}

const runBadges: Record<string, { label: string; tone: Tone }> = {
  succeeded: { label: 'Run succeeded', tone: Tones.ok },
  failed: { label: 'Run failed', tone: Tones.danger },
  rejected: { label: 'Run rejected', tone: Tones.danger },
  canceled: { label: 'Run canceled', tone: Tones.neutral },
};

/** One run of the linked pipeline, between the changesets. */
function RunRow({ workspaceId, run }: { workspaceId: string; run: TimelineRunDto }) {
  const badge = runBadges[run.state] ?? { label: `Run ${run.state.replaceAll('_', ' ')}`, tone: Tones.warn };
  return (
    <li
      aria-label={`Run ${run.commitSha.slice(0, 7)}`}
      className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-sm">
      <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
      <Link
        href={Routes.workspaceRun(workspaceId, run.id)}
        className="font-mono text-xs underline-offset-2 hover:underline">
        {run.commitSha.slice(0, 7)}
      </Link>
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
        {run.commitMessage.split('\n', 1)[0]}
      </span>
      <span className="text-xs text-muted-foreground">
        <Ago date={run.finishedAt ?? run.createdAt} />
      </span>
    </li>
  );
}

/** Which repo's pipeline runs show on the timeline. Correlation only: it changes no rule or gate. */
function LinkedPipeline({ workspaceId, projectId, environment }: Props & { environment: FlagEnvironmentDto }) {
  const utils = trpc.useUtils();
  const linksQuery = trpc.project.listRepos.useQuery({ workspaceId, projectId });
  const reposQuery = trpc.integration.repos.useQuery({ workspaceId }, { retry: false });
  const link = trpc.flags.setLinkedPipeline.useMutation({
    onSuccess: async () => {
      await Promise.all([utils.flags.environments.invalidate(), utils.flags.timeline.invalidate()]);
    },
  });
  const linkedIds = new Set((linksQuery.data?.links ?? []).map(entry => entry.repoId));
  const repos = (reposQuery.data?.repos ?? []).filter(repo => linkedIds.has(repo.id));
  if (repos.length === 0) {
    return null;
  }
  return (
    <label className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      Show the runs of
      <select
        aria-label={`Linked pipeline of ${environment.name}`}
        value={environment.linkedRepoId ?? ''}
        disabled={link.isPending}
        className={`${inputClass} w-auto py-1 text-xs`}
        onChange={event => {
          link.mutate({
            workspaceId,
            projectId,
            environmentId: environment.id,
            repoId: event.target.value === '' ? null : event.target.value,
          });
        }}>
        <option value="">no pipeline</option>
        {repos.map(repo => (
          <option key={repo.id} value={repo.id}>
            {repo.owner}/{repo.name}
          </option>
        ))}
      </select>
      {link.error ? <span className="text-destructive">{errorMessage(link.error)}</span> : null}
    </label>
  );
}

/** The environment's changesets, and the linked pipeline's runs between them, newest first. */
function History({ workspaceId, projectId, environment }: Props & { environment: FlagEnvironmentDto }) {
  const timelineQuery = trpc.flags.timeline.useQuery({ workspaceId, projectId, environmentId: environment.id });

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium">History of {environment.name}</h2>
        <LinkedPipeline workspaceId={workspaceId} projectId={projectId} environment={environment} />
      </div>
      {timelineQuery.isLoading ? <Spinner /> : null}
      <ul className="flex flex-col gap-2">
        {(timelineQuery.data?.entries ?? []).map(entry =>
          entry.kind === 'run' ? (
            <RunRow key={`run:${entry.run.id}`} workspaceId={workspaceId} run={entry.run} />
          ) : (
            <ChangesetRow
              key={entry.changeset.id}
              workspaceId={workspaceId}
              projectId={projectId}
              changeset={entry.changeset}
            />
          ),
        )}
      </ul>
    </section>
  );
}

/** Segments and history of the environment chosen in the tabs (`?env=`). */
function PerEnvironment({ workspaceId, projectId, environments }: Props & { environments: FlagEnvironmentDto[] }) {
  const router = useRouter();
  const selectedId = typeof router.query.env === 'string' ? router.query.env : undefined;
  const environment = environments.find(candidate => candidate.id === selectedId) ?? environments[0];
  if (environment === undefined) {
    return null;
  }

  return (
    <div className="flex flex-col gap-6">
      <nav aria-label="Environment" className="flex gap-1 border-b border-border">
        {environments.map(candidate => (
          <Link
            key={candidate.id}
            href={Routes.projectFlags(workspaceId, projectId, candidate.id)}
            aria-current={candidate.id === environment.id ? 'page' : undefined}
            className={`-mb-px border-b-2 px-3 py-1.5 text-sm ${
              candidate.id === environment.id
                ? 'border-foreground font-medium'
                : 'border-transparent text-muted-foreground'
            }`}>
            {candidate.name}
          </Link>
        ))}
      </nav>
      <Protection workspaceId={workspaceId} projectId={projectId} environment={environment} />
      <Segments workspaceId={workspaceId} projectId={projectId} environment={environment} />
      <History workspaceId={workspaceId} projectId={projectId} environment={environment} />
    </div>
  );
}

const syncBadges: Record<FlagFileSyncDto['state'], { label: string; tone: Tone }> = {
  applied: { label: 'Applied', tone: Tones.ok },
  pending_approval: { label: 'Waiting for approval', tone: Tones.warn },
  unchanged: { label: 'No changes', tone: Tones.neutral },
  invalid: { label: 'Refused', tone: Tones.danger },
};

/** The last syncs of `.mocco/flags.yml`: how each commit landed and why a file was refused. */
function RepoSyncs({ workspaceId, projectId }: Props) {
  const syncsQuery = trpc.flags.fileSyncs.useQuery({ workspaceId, projectId });
  const syncs = syncsQuery.data?.syncs ?? [];
  if (syncs.length === 0) {
    return null;
  }
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">From the repository</h3>
      <p className="text-xs text-muted-foreground">
        Pushes to the default branch sync <span className="font-mono">.mocco/flags.yml</span>. A refused file changes
        nothing.
      </p>
      <ul className="flex flex-col gap-1.5">
        {syncs.slice(0, 5).map(sync => (
          <li
            key={sync.id}
            aria-label={`Sync of ${sync.commitSha.slice(0, 7)}`}
            className="flex flex-col gap-1 rounded-lg border border-border px-3 py-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge tone={syncBadges[sync.state].tone}>{syncBadges[sync.state].label}</StatusBadge>
              <span className="font-mono text-xs">{sync.commitSha.slice(0, 7)}</span>
              <span className="text-xs text-muted-foreground">
                <Ago date={sync.createdAt} />
              </span>
            </div>
            {sync.issues.length === 0 ? null : (
              <ul className="font-mono text-xs text-destructive">
                {sync.issues.map(issue => (
                  <li key={`${issue.path}:${issue.message}`}>
                    {issue.path === '' ? '' : `${issue.path}: `}
                    {issue.message}
                    {issue.line === undefined ? '' : ` (line ${issue.line})`}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The flags screen: environments, the flag × environment switches, and per environment its segments and history. */
export default function FeatureFlags({ workspaceId, projectId }: Props) {
  const input = { workspaceId, projectId };
  const environmentsQuery = trpc.flags.environments.useQuery(input);
  const flagsQuery = trpc.flags.list.useQuery(input);
  const staleQuery = trpc.flags.stale.useQuery(input);
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
      <Flags
        workspaceId={workspaceId}
        projectId={projectId}
        environments={environments}
        flags={flags}
        stale={staleQuery.data?.findings ?? []}
      />
      <RepoSyncs workspaceId={workspaceId} projectId={projectId} />
      <PerEnvironment workspaceId={workspaceId} projectId={projectId} environments={environments} />
    </div>
  );
}
