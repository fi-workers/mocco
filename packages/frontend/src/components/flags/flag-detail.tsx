import Link from 'next/link';
import { useRouter } from 'next/router';
import { useState } from 'react';

import KillSwitch from '@frontend/components/flags/kill-switch';
import { ruleDraftOf, toRule, toServe } from '@frontend/components/flags/rule-drafts';
import { RulesEditor, ServeEditor } from '@frontend/components/flags/rule-editor';
import { FlagUsage } from '@frontend/components/flags/stale';
import {
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

import type { RuleDraft, ServeDraft } from '@frontend/components/flags/rule-drafts';
import type { ChangeOp, FlagConfigDto, FlagDto, FlagEnvironmentDto } from '@mocco/common/flags';

interface Props {
  workspaceId: string;
  projectId: string;
  flagKey: string;
}

interface Draft {
  enabled: boolean;
  offVariant: string;
  rules: RuleDraft[];
  fallthrough: ServeDraft;
}

const draftOf = (config: FlagConfigDto): Draft => ({
  enabled: config.enabled,
  offVariant: config.offVariant,
  rules: config.rules.map(rule => ruleDraftOf(rule)),
  fallthrough:
    config.rollout === null
      ? { kind: 'variant', variant: config.defaultVariant }
      : { kind: 'rollout', rollout: config.rollout },
});

const isSame = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The ops that turn `config` into `draft`: only what changed. */
function opsOf(flagKey: string, config: FlagConfigDto, draft: Draft): ChangeOp[] {
  const rules = draft.rules.map(rule => toRule(rule));
  const fallthrough = toServe(draft.fallthrough);
  const ops: ChangeOp[] = [];
  if (!isSame(rules, config.rules)) {
    ops.push({ op: 'set_rules', flagKey, rules });
  }
  if ('variant' in fallthrough) {
    if (fallthrough.variant !== config.defaultVariant) {
      ops.push({ op: 'set_default_variant', flagKey, variant: fallthrough.variant });
    }
    if (config.rollout !== null) {
      ops.push({ op: 'set_rollout', flagKey, rollout: null });
    }
  } else if (!isSame(fallthrough.rollout, config.rollout)) {
    ops.push({ op: 'set_rollout', flagKey, rollout: fallthrough.rollout });
  }
  if (draft.enabled !== config.enabled) {
    ops.push({ op: 'set_enabled', flagKey, enabled: draft.enabled });
  }
  if (draft.offVariant !== config.offVariant) {
    ops.push({ op: 'set_off_variant', flagKey, variant: draft.offVariant });
  }
  return ops;
}

/** `100 · variant large · TARGETING_MATCH`, with the error code when there is one. */
function describeResult(result: { value: unknown; variant: string | null; reason: string; errorCode: string | null }) {
  const parts = [JSON.stringify(result.value), `variant ${result.variant ?? '—'}`, result.reason];
  return result.errorCode === null ? parts.join(' · ') : `${parts.join(' · ')} (${result.errorCode})`;
}

/** "No unsaved changes." or "2 changes not saved yet." */
function pendingText(count: number) {
  if (count === 0) {
    return 'No unsaved changes.';
  }
  return count === 1 ? '1 change not saved yet.' : `${count} changes not saved yet.`;
}

function Preview({
  workspaceId,
  projectId,
  environmentId,
  flagKey,
  ops,
}: Omit<Props, 'flagKey'> & { environmentId: string; flagKey: string; ops: ChangeOp[] }) {
  const utils = trpc.useUtils();
  const [contextText, setContextText] = useState('{\n  "targetingKey": "user-1",\n  "plan": "pro"\n}');
  const [result, setResult] = useState<{ text: string; isError: boolean } | null>(null);
  const [isPending, setIsPending] = useState(false);

  const evaluate = async () => {
    let context: Record<string, unknown>;
    try {
      context = JSON.parse(contextText) as Record<string, unknown>;
    } catch {
      setResult({ text: 'The context must be a JSON object.', isError: true });
      return;
    }
    setIsPending(true);
    let outcome: { text: string; isError: boolean };
    try {
      const { results } = await utils.flags.preview.fetch({ workspaceId, projectId, environmentId, ops, context });
      const mine = results.find(item => item.flagKey === flagKey);
      outcome = { text: mine === undefined ? 'Not in this environment.' : describeResult(mine), isError: false };
    } catch (error) {
      outcome = { text: errorMessage(error as { message: string }) ?? 'Preview failed', isError: true };
    }
    // Not a `finally`: the React Compiler can't optimize a component with one.
    setResult(outcome);
    setIsPending(false);
  };

  return (
    <section className="flex flex-col gap-2 rounded-xl border border-border p-4">
      <h3 className="text-sm font-medium">Preview</h3>
      <p className="text-xs text-muted-foreground">
        Evaluates this flag for an evaluation context with the changes below, before you save them. It uses the same
        evaluator as the SDKs.
      </p>
      <label className={labelClass}>
        Evaluation context (JSON)
        <textarea
          rows={4}
          value={contextText}
          className={`${inputClass} h-auto py-1.5 font-mono text-xs`}
          onChange={event => {
            setContextText(event.target.value);
          }}
        />
      </label>
      <Button
        variant="outline"
        size="sm"
        className="w-fit text-xs"
        pending={isPending}
        onClick={() => {
          // eslint-disable-next-line no-void -- an onClick handler can't await; evaluate() reports its own errors
          void evaluate();
        }}>
        Evaluate
      </Button>
      {result === null ? null : (
        <p aria-label="Preview result" className={`font-mono text-xs ${result.isError ? 'text-destructive' : ''}`}>
          {result.text}
        </p>
      )}
    </section>
  );
}

function EnvironmentEditor({
  workspaceId,
  projectId,
  flag,
  environment,
  config,
}: Omit<Props, 'flagKey'> & { flag: FlagDto; environment: FlagEnvironmentDto; config: FlagConfigDto }) {
  const utils = trpc.useUtils();
  const [draft, setDraft] = useState<Draft>(() => draftOf(config));
  const segmentsQuery = trpc.flags.segments.useQuery({ workspaceId, projectId, environmentId: environment.id });
  const segmentKeys = (segmentsQuery.data?.segments ?? []).map(segment => segment.key);
  const variants = Object.keys(flag.variants);
  const ops = opsOf(flag.key, config, draft);
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const isProtected = environment.changeGate !== null;
  // `.mocco/flags.yml` owns this flag: everything but the kill switch is read-only here.
  const isRepoManaged = flag.managedBy === 'repo';
  const save = trpc.flags.applyChangeset.useMutation({
    onSuccess: async result => {
      if (result.outcome === 'pending_approval') {
        setNotice(
          "Sent for approval: it applies once the environment's protection is satisfied. Follow it in the History on the Feature flags tab.",
        );
        setDraft(draftOf(config));
        setReason('');
      }
      await Promise.all([
        utils.flags.list.invalidate(),
        utils.flags.environments.invalidate(),
        utils.flags.history.invalidate(),
      ]);
    },
  });

  return (
    <div className="flex flex-col gap-4">
      {environment.changeGate === null ? null : (
        <Notice tone={Tones.warn} title="Protected environment">
          Changes here need approval under the environment&apos;s change gate.
        </Notice>
      )}
      <fieldset disabled={isRepoManaged} className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={event => {
              setDraft({ ...draft, enabled: event.target.checked });
            }}
          />
          Enabled in {environment.name}
          <span className="text-xs text-muted-foreground">(when off, callers get the default in their code)</span>
        </label>
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Rules</h3>
          <p className="text-xs text-muted-foreground">
            Tried in order; the first rule whose conditions all match serves. Attributes come from the evaluation
            context your code passes (for example <span className="font-mono">plan</span> or{' '}
            <span className="font-mono">appVersion</span>); rollouts bucket on its{' '}
            <span className="font-mono">targetingKey</span>.
          </p>
          <RulesEditor
            rules={draft.rules}
            variants={variants}
            segmentKeys={segmentKeys}
            onChange={rules => {
              setDraft({ ...draft, rules });
            }}
          />
        </section>
        <section className="flex flex-col gap-1">
          <h3 className="text-sm font-medium">When no rule matches</h3>
          <ServeEditor
            label="serve"
            draft={draft.fallthrough}
            variants={variants}
            onChange={fallthrough => {
              setDraft({ ...draft, fallthrough });
            }}
          />
          {draft.fallthrough.kind === 'rollout' ? (
            <p className="text-xs text-muted-foreground">
              Callers without a targeting key get <span className="font-mono">{config.defaultVariant}</span>. Raising a
              share only adds keys to that variant.
            </p>
          ) : null}
        </section>
        <label className={`${labelClass} w-fit`}>
          Off variant (what a kill serves)
          <select
            value={draft.offVariant}
            className={`${inputClass} font-mono`}
            onChange={event => {
              setDraft({ ...draft, offVariant: event.target.value });
            }}>
            {variants.map(variant => (
              <option key={variant} value={variant}>
                {variant}
              </option>
            ))}
          </select>
        </label>
      </fieldset>
      <Preview
        workspaceId={workspaceId}
        projectId={projectId}
        environmentId={environment.id}
        flagKey={flag.key}
        ops={ops}
      />
      {isProtected && !isRepoManaged ? (
        <label className={labelClass}>
          Reason for the approvers (optional)
          <input
            value={reason}
            maxLength={500}
            className={inputClass}
            onChange={event => {
              setReason(event.target.value);
            }}
          />
        </label>
      ) : null}
      {isRepoManaged ? null : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            pending={save.isPending}
            disabled={ops.length === 0}
            className="text-sm"
            onClick={() => {
              setNotice(null);
              save.mutate({
                workspaceId,
                projectId,
                environmentId: environment.id,
                baseVersion: environment.currentVersion,
                ops,
                reason: reason === '' ? null : reason,
              });
            }}>
            {isProtected ? `Propose changes to ${environment.name}` : `Save changes to ${environment.name}`}
          </Button>
          <span className="text-xs text-muted-foreground">{pendingText(ops.length)}</span>
        </div>
      )}
      {notice === null ? null : (
        <Notice tone={Tones.warn} title="Waiting for approval">
          {notice}
        </Notice>
      )}
      {save.error ? <p className="text-sm text-destructive">{errorMessage(save.error)}</p> : null}
      <KillSwitch
        workspaceId={workspaceId}
        projectId={projectId}
        flagKey={flag.key}
        environment={environment}
        config={config}
      />
    </div>
  );
}

/** Whether browsers and apps (publishable keys, over OFREP) may evaluate this flag. */
function ClientVisibility({ workspaceId, projectId, flag }: Omit<Props, 'flagKey'> & { flag: FlagDto }) {
  const utils = trpc.useUtils();
  const change = trpc.flags.setClientVisible.useMutation({
    onSuccess: async () => {
      await utils.flags.list.invalidate();
    },
  });
  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={flag.clientVisible}
          disabled={change.isPending || flag.managedBy === 'repo'}
          onChange={event => {
            change.mutate({ workspaceId, projectId, flagKey: flag.key, clientVisible: event.target.checked });
          }}
        />
        Available to browsers and apps
      </label>
      <p className="text-xs text-muted-foreground">
        Publishable keys evaluate only flags marked available, and only ever get the resolved value — never the rules.
        Server keys see every flag.
      </p>
      {change.error ? <p className="text-xs text-destructive">{errorMessage(change.error)}</p> : null}
    </div>
  );
}

/** One flag: its variants, and per environment its rules, fallthrough and preview. */
export default function FlagDetail({ workspaceId, projectId, flagKey }: Props) {
  const router = useRouter();
  const input = { workspaceId, projectId };
  const flagsQuery = trpc.flags.list.useQuery(input);
  const environmentsQuery = trpc.flags.environments.useQuery(input);
  if (flagsQuery.isLoading || environmentsQuery.isLoading) {
    return <Spinner />;
  }
  const flag = flagsQuery.data?.flags.find(candidate => candidate.key === flagKey);
  const environments = environmentsQuery.data?.environments ?? [];
  if (flag === undefined) {
    return <p className="text-sm text-muted-foreground">This project has no flag “{flagKey}”.</p>;
  }
  const selectedId = typeof router.query.env === 'string' ? router.query.env : undefined;
  const environment = environments.find(candidate => candidate.id === selectedId) ?? environments[0];
  const config = flag.configs.find(candidate => candidate.environmentId === environment?.id);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <p className="text-xs text-muted-foreground">
          <Link href={Routes.projectFlags(workspaceId, projectId)} className="hover:text-foreground">
            Feature flags
          </Link>{' '}
          / <span className="font-mono">{flag.key}</span>
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-mono text-base font-semibold">{flag.key}</h2>
          <StatusBadge tone={Tones.neutral}>{flag.type}</StatusBadge>
          <StatusBadge tone={Tones.neutral}>{flag.lifecycle}</StatusBadge>
        </div>
        {flag.description ? <p className="text-sm text-muted-foreground">{flag.description}</p> : null}
      </div>
      {flag.managedBy === 'repo' ? (
        <Notice tone={Tones.neutral} title="Managed by .mocco/flags.yml">
          This flag is defined in your repository. Change it there and merge to the default branch: unprotected
          environments update at once, protected ones wait for approval. The kill switch still works here.
        </Notice>
      ) : null}
      <ClientVisibility workspaceId={workspaceId} projectId={projectId} flag={flag} />
      <FlagUsage scope={input} flagKey={flag.key} />
      <section className="flex flex-col gap-1">
        <h3 className="text-sm font-medium">Variants</h3>
        <ul className="flex flex-wrap gap-2">
          {Object.entries(flag.variants).map(([name, value]) => (
            <li key={name} className="rounded-md border border-border px-2 py-1 font-mono text-xs">
              {name} = {JSON.stringify(value)}
            </li>
          ))}
        </ul>
      </section>
      <nav aria-label="Environment" className="flex gap-1 border-b border-border">
        {environments.map(candidate => (
          <Link
            key={candidate.id}
            href={Routes.projectFlag(workspaceId, projectId, flag.key, candidate.id)}
            aria-current={candidate.id === environment?.id ? 'page' : undefined}
            className={`-mb-px border-b-2 px-3 py-1.5 text-sm ${
              candidate.id === environment?.id
                ? 'border-foreground font-medium'
                : 'border-transparent text-muted-foreground'
            }`}>
            {candidate.name}
          </Link>
        ))}
      </nav>
      {environment === undefined || config === undefined ? (
        <p className="text-sm text-muted-foreground">Create an environment on the Feature flags tab first.</p>
      ) : (
        <EnvironmentEditor
          // A saved change or another environment starts a fresh draft.
          key={`${environment.id}:${config.version}`}
          workspaceId={workspaceId}
          projectId={projectId}
          flag={flag}
          environment={environment}
          config={config}
        />
      )}
    </div>
  );
}
