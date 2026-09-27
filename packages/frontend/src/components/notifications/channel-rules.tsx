import { DomainEventTypes } from '@mocco/common/events';
import { RulePresets, rulePresetSchema } from '@mocco/common/notification-presets';
import { useState } from 'react';

import {
  errorMessage,
  inputClass,
  labelClass,
  Notice,
  Tones,
} from '@frontend/components/notifications/notification-ui';
import { Button } from '@frontend/components/ui/button';
import { fireAndForget } from '@frontend/lib/fire-and-forget';
import { trpc } from '@frontend/lib/trpc';
import { cn } from '@frontend/lib/utils';

import type { InboundSourceDto } from '@mocco/common/inbound';
import type { NotificationRuleDto, RuleFilter } from '@mocco/common/notification';
import type { RulePreset } from '@mocco/common/notification-presets';

/** Every family of events, as the prefix wildcards a rule may name. */
const WILDCARDS = ['gate.*', 'run.*', 'sentry.*', 'vercel.*', 'github.*'] as const;
const EVENT_TYPES = [...WILDCARDS, ...Object.values(DomainEventTypes)];

const PRESET_LABELS: Record<RulePreset, string> = {
  [RulePresets.mocco]: 'Mocco (gates and failed runs)',
  [RulePresets.sentry]: 'Sentry (new issues)',
  [RulePresets.vercel]: 'Vercel (production deploys, errors, cancels)',
  [RulePresets.github]: 'GitHub (pushes, PRs, issues, releases, failed workflows)',
};

const FILTER_LINE = /^([^=]+)=(.+)$/u;
const FILTER_BLANK = /^\s*$/u;

/**
 * `key=value` per line → a flat filter. `true`/`false` become booleans (facts like
 * `hasCommits` are booleans, compared strictly). Returns an error for a malformed line.
 */
export function parseFilter(text: string): { filter: RuleFilter } | { error: string } {
  const lines = text // eslint-disable-line sonarjs/null-dereference -- a string parameter, never null
    .split('\n')
    .filter(line => !FILTER_BLANK.test(line));
  const parsed = lines.map(line => {
    const match = FILTER_LINE.exec(line);
    return { line, key: match?.[1]?.trim() ?? '', value: match?.[2]?.trim() ?? '' };
  });
  const malformed = parsed.find(({ key, value }) => key === '' || value === '');
  if (malformed !== undefined) {
    return { error: `"${malformed.line}" is not key=value` };
  }
  const entries = parsed.map(
    ({ key, value }) => [key, value === 'true' || value === 'false' ? value === 'true' : value] as const,
  );
  return { filter: Object.fromEntries(entries) };
}

function FilterChips({ filter }: { filter: RuleFilter }) {
  const entries = Object.entries(filter);
  if (entries.length === 0) {
    return <span className="text-xs text-muted-foreground">every event</span>;
  }
  return (
    <span className="flex flex-wrap gap-1">
      {entries.map(([key, value]) => (
        <code key={key} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
          {key} = {typeof value === 'string' ? `"${value}"` : String(value)}
        </code>
      ))}
    </span>
  );
}

function sourceLabel(sources: InboundSourceDto[], sourceId: string | null): string | null {
  if (sourceId === null) {
    return null;
  }
  return sources.find(source => source.id === sourceId)?.name ?? 'a deleted source';
}

interface Props {
  workspaceId: string;
  channelId: string;
  canEdit: boolean;
  sources: InboundSourceDto[];
}

function RuleRow({ rule, workspaceId, channelId, canEdit, sources }: Props & { rule: NotificationRuleDto }) {
  const utils = trpc.useUtils();
  const remove = trpc.notification.removeRule.useMutation({
    onSuccess: () => {
      fireAndForget(utils.notification.rules.invalidate({ workspaceId, channelId }));
    },
  });
  const source = sourceLabel(sources, rule.sourceId);

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
      <code className="font-mono text-xs font-medium">{rule.eventType}</code>
      <FilterChips filter={rule.filter} />
      {source === null ? null : <span className="text-xs text-muted-foreground">from {source}</span>}
      {canEdit ? (
        <Button
          variant="ghost"
          size="xs"
          className="ml-auto"
          pending={remove.isPending}
          aria-label={`Remove rule ${rule.eventType}`}
          onClick={() => {
            remove.mutate({ workspaceId, ruleId: rule.id });
          }}>
          Remove
        </Button>
      ) : null}
    </li>
  );
}

function AddRuleForm({ workspaceId, channelId, sources }: Omit<Props, 'canEdit'>) {
  const utils = trpc.useUtils();
  const [eventType, setEventType] = useState<string>(DomainEventTypes.gatePending);
  const [sourceId, setSourceId] = useState('');
  const [filterText, setFilterText] = useState('');
  const [filterError, setFilterError] = useState<string | null>(null);
  const add = trpc.notification.addRule.useMutation({
    onSuccess: () => {
      setFilterText('');
      fireAndForget(utils.notification.rules.invalidate({ workspaceId, channelId }));
    },
  });

  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={event => {
        event.preventDefault();
        const parsed = parseFilter(filterText);
        if ('error' in parsed) {
          setFilterError(parsed.error);
          return;
        }
        setFilterError(null);
        add.mutate({
          workspaceId,
          channelId,
          eventType,
          sourceId: sourceId === '' ? null : sourceId,
          filter: parsed.filter,
        });
      }}>
      <label className={labelClass}>
        Event type
        <select
          className={inputClass}
          value={eventType}
          onChange={event => {
            setEventType(event.target.value);
          }}>
          {EVENT_TYPES.map(type => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
      </label>
      <label className={labelClass}>
        Only from source
        <select
          className={inputClass}
          value={sourceId}
          onChange={event => {
            setSourceId(event.target.value);
          }}>
          <option value="">Any source</option>
          {sources.map(source => (
            <option key={source.id} value={source.id}>
              {source.name}
            </option>
          ))}
        </select>
      </label>
      <label className={labelClass}>
        Filter (optional, key=value per line)
        <textarea
          rows={1}
          className={cn(inputClass, 'h-8 min-w-48 resize-y py-1.5 font-mono text-xs')}
          placeholder="target=production"
          value={filterText}
          onChange={event => {
            setFilterText(event.target.value);
          }}
        />
      </label>
      <Button type="submit" variant="secondary" pending={add.isPending}>
        Add rule
      </Button>
      {filterError === null && add.error === null ? null : (
        <p role="alert" className="basis-full text-xs text-destructive">
          {filterError ?? errorMessage(add.error)}
        </p>
      )}
    </form>
  );
}

const pluralRules = (count: number) => (count === 1 ? '1 rule' : `${count} rules`);

function ApplyPresetForm({ workspaceId, channelId, sources }: Omit<Props, 'canEdit'>) {
  const utils = trpc.useUtils();
  const [preset, setPreset] = useState<RulePreset>(RulePresets.mocco);
  const [sourceId, setSourceId] = useState('');
  const apply = trpc.notification.applyDefaultRules.useMutation({
    onSuccess: () => {
      fireAndForget(utils.notification.rules.invalidate({ workspaceId, channelId }));
    },
  });
  const presetSources = sources.filter(source => source.kind === preset);

  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={event => {
        event.preventDefault();
        apply.mutate({ workspaceId, channelId, preset, sourceId: sourceId === '' ? null : sourceId });
      }}>
      <label className={labelClass}>
        Apply preset
        <select
          className={inputClass}
          value={preset}
          onChange={event => {
            const parsed = rulePresetSchema.safeParse(event.target.value);
            if (parsed.success) {
              setPreset(parsed.data);
              setSourceId('');
            }
          }}>
          {rulePresetSchema.options.map(option => (
            <option key={option} value={option}>
              {PRESET_LABELS[option]}
            </option>
          ))}
        </select>
      </label>
      {preset === RulePresets.mocco ? null : (
        <label className={labelClass}>
          Source
          <select
            className={inputClass}
            value={sourceId}
            onChange={event => {
              setSourceId(event.target.value);
            }}>
            <option value="">Any {preset} source</option>
            {presetSources.map(source => (
              <option key={source.id} value={source.id}>
                {source.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <Button type="submit" variant="outline" pending={apply.isPending}>
        Apply
      </Button>
      {apply.data === undefined ? null : (
        <p role="status" className="basis-full text-xs text-muted-foreground">
          {apply.data.rules.length === 0
            ? 'The channel already has every rule of this preset.'
            : `Added ${pluralRules(apply.data.rules.length)}.`}
        </p>
      )}
      {apply.error === null ? null : (
        <p role="alert" className="basis-full text-xs text-destructive">
          {apply.error.message}
        </p>
      )}
    </form>
  );
}

/** A channel's rules: which events it gets. Owners and admins can add and remove rules. */
export default function ChannelRules(props: Props) {
  const { workspaceId, channelId, canEdit } = props;
  const rulesQuery = trpc.notification.rules.useQuery({ workspaceId, channelId });
  const rules = rulesQuery.data?.rules ?? [];

  return (
    <section aria-label="Rules" className="flex flex-col gap-3">
      <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Rules</h4>
      {rulesQuery.isPending || rules.length > 0 ? null : (
        <Notice tone={Tones.warn} title="No rules yet">
          This channel receives nothing until it has a rule.{' '}
          {canEdit ? 'Apply a preset below to start.' : 'Ask an owner or admin to add one.'}
        </Notice>
      )}
      {rules.length === 0 ? null : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {rules.map(rule => (
            <RuleRow
              key={rule.id}
              rule={rule}
              workspaceId={workspaceId}
              channelId={channelId}
              canEdit={canEdit}
              sources={props.sources}
            />
          ))}
        </ul>
      )}
      {canEdit ? (
        <div className="flex flex-col gap-3 rounded-lg bg-muted/40 p-3">
          <ApplyPresetForm {...props} />
          <AddRuleForm {...props} />
        </div>
      ) : null}
    </section>
  );
}
