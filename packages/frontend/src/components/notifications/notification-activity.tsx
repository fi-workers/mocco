import { InboundKinds, InboundOutcomes, inboundOutcomeSchema } from '@mocco/common/inbound';
import { DeliveryStatuses } from '@mocco/common/notification';
import { ActivityChannelResultKinds, ActivityItemKinds } from '@mocco/common/notification-activity';
import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { discordFixHint } from '@frontend/components/notifications/discord-hints';
import {
  Ago,
  inputClass,
  labelClass,
  Notice,
  Spinner,
  StatusBadge,
  Tones,
} from '@frontend/components/notifications/notification-ui';
import { Button } from '@frontend/components/ui/button';
import { fireAndForget } from '@frontend/lib/fire-and-forget';
import { Routes } from '@frontend/lib/routes';
import { trpc } from '@frontend/lib/trpc';
import { cn } from '@frontend/lib/utils';

import type { Tone } from '@frontend/components/notifications/notification-ui';
import type { InboundKind, InboundOutcome } from '@mocco/common/inbound';
import type { DeliveryStatus } from '@mocco/common/notification';
import type {
  ActivityChannelResultDto,
  ActivityDeliveryDto,
  ActivityItemDto,
} from '@mocco/common/notification-activity';

/** The trace's filters, parsed from the URL by the page. */
export interface ActivityFilters {
  sourceId?: string;
  channelId?: string;
  outcome?: InboundOutcome;
}

interface Props {
  workspaceId: string;
  filters: ActivityFilters;
  onFiltersChange: (filters: ActivityFilters) => void;
}

const POLL_MS = 15_000;

const OUTCOME_TONES: Record<InboundOutcome, Tone> = {
  [InboundOutcomes.published]: Tones.ok,
  [InboundOutcomes.pending]: Tones.neutral,
  [InboundOutcomes.ignored]: Tones.neutral,
  [InboundOutcomes.over_quota]: Tones.danger,
};

const OUTCOME_LABELS: Record<InboundOutcome, string> = {
  [InboundOutcomes.published]: 'published',
  [InboundOutcomes.pending]: 'pending',
  [InboundOutcomes.ignored]: 'ignored',
  [InboundOutcomes.over_quota]: 'over quota',
};

const DELIVERY_TONES: Record<DeliveryStatus, Tone> = {
  [DeliveryStatuses.sent]: Tones.ok,
  [DeliveryStatuses.queued]: Tones.warn,
  [DeliveryStatuses.sending]: Tones.warn,
  [DeliveryStatuses.failed]: Tones.danger,
  [DeliveryStatuses.suppressed]: Tones.neutral,
};

const KIND_LABELS: Record<InboundKind, string> = {
  [InboundKinds.sentry]: 'Sentry',
  [InboundKinds.vercel]: 'Vercel',
  [InboundKinds.github]: 'GitHub',
};

function sourceLabel(item: ActivityItemDto): string {
  if (item.kind === ActivityItemKinds.event) {
    return 'Mocco';
  }
  return item.source === null ? 'Deleted source' : item.source.name;
}

/** "in 3 min" for a time ahead (the next retry). */
function formatIn(date: Date): string {
  const minutes = Math.max(0, Math.round((date.getTime() - Date.now()) / 60_000));
  if (minutes < 1) {
    return 'in under a minute';
  }
  return minutes < 60 ? `in ${minutes} min` : `in ${Math.round(minutes / 60)} h`;
}

/** The summary label of one channel result (none for a channel added later). */
function summaryOf(result: ActivityChannelResultDto): { label: string; tone: Tone } | undefined {
  switch (result.kind) {
    case ActivityChannelResultKinds.delivery: {
      return { label: result.delivery.status, tone: DELIVERY_TONES[result.delivery.status] };
    }
    case ActivityChannelResultKinds.no_match: {
      return { label: 'no rule', tone: Tones.neutral };
    }
    case ActivityChannelResultKinds.channel_disabled: {
      return { label: 'disabled', tone: Tones.danger };
    }
    default: {
      return undefined;
    }
  }
}

/** The per-channel summary of a row: how many were sent, failed, waiting or unmatched. */
function ChannelSummary({ item }: { item: ActivityItemDto }) {
  const counts = item.channels.reduce((map, result) => {
    const summary = summaryOf(result);
    if (summary !== undefined) {
      map.set(summary.label, { tone: summary.tone, count: (map.get(summary.label)?.count ?? 0) + 1 });
    }
    return map;
  }, new Map<string, { tone: Tone; count: number }>());
  if (counts.size === 0) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  return (
    <span className="flex flex-wrap gap-1">
      {Array.from(counts, ([label, { tone, count }]) => (
        <StatusBadge key={label} tone={tone}>
          {count} {label}
        </StatusBadge>
      ))}
    </span>
  );
}

function DeliveryResult({ name, delivery }: { name: string; delivery: ActivityDeliveryDto }) {
  const hint = discordFixHint(delivery.error);
  const isWaiting = delivery.nextAttemptAt !== null && delivery.status === DeliveryStatuses.queued;
  return (
    <li className="flex flex-col gap-1 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{name}</span>
        <StatusBadge tone={DELIVERY_TONES[delivery.status]}>{delivery.status}</StatusBadge>
        <span className="text-xs text-muted-foreground">
          {delivery.attempts === 1 ? '1 attempt' : `${delivery.attempts} attempts`}
          {delivery.responseCode === null ? '' : ` · HTTP ${delivery.responseCode}`}
          {delivery.sentAt === null ? null : (
            <>
              {' · sent '}
              <Ago date={delivery.sentAt} />
            </>
          )}
        </span>
      </div>
      {delivery.error === null ? null : (
        <p className="font-mono text-xs text-muted-foreground">
          {delivery.status === DeliveryStatuses.failed ? 'Error: ' : 'Last error: '}
          {delivery.error}
        </p>
      )}
      {isWaiting && delivery.nextAttemptAt !== null ? (
        <p className="text-xs text-muted-foreground">
          Next retry {formatIn(delivery.nextAttemptAt)} ({delivery.nextAttemptAt.toLocaleTimeString()})
        </p>
      ) : null}
      {hint === undefined ? null : <p className="text-xs">{hint}</p>}
    </li>
  );
}

function ChannelResult({ result }: { result: ActivityChannelResultDto }) {
  const name = result.channelName ?? 'Deleted channel';
  switch (result.kind) {
    case ActivityChannelResultKinds.delivery: {
      return <DeliveryResult name={name} delivery={result.delivery} />;
    }
    case ActivityChannelResultKinds.no_match: {
      return (
        <li className="flex flex-wrap items-center gap-2 px-3 py-2.5">
          <span className="text-sm font-medium">{name}</span>
          <span className="text-xs text-muted-foreground">
            No rule matched: <span className="font-mono text-foreground">{result.reason}</span>
          </span>
        </li>
      );
    }
    case ActivityChannelResultKinds.channel_disabled: {
      return (
        <li className="flex flex-wrap items-center gap-2 px-3 py-2.5">
          <span className="text-sm font-medium">{name}</span>
          <StatusBadge tone={Tones.danger}>channel disabled</StatusBadge>
          <span className="font-mono text-xs text-muted-foreground">{result.reason ?? ''}</span>
        </li>
      );
    }
    case ActivityChannelResultKinds.channel_added_later: {
      return (
        <li className="flex flex-wrap items-center gap-2 px-3 py-2.5">
          <span className="text-sm font-medium">{name}</span>
          <span className="text-xs text-muted-foreground">Channel added after this event</span>
        </li>
      );
    }
    default: {
      return null;
    }
  }
}

/** Why a row lists no channels. */
function noChannelsText(item: ActivityItemDto): string {
  if (item.outcome === InboundOutcomes.pending) {
    return 'The event is being published; channels show up in a moment.';
  }
  if (item.outcome === InboundOutcomes.published || item.outcome === null) {
    return 'The workspace has no channels.';
  }
  return 'No event was published, so no channel was considered.';
}

function ReceiptFacts({ item }: { item: ActivityItemDto }) {
  return (
    <>
      <dt className="text-muted-foreground">Outcome</dt>
      <dd>{item.outcome === null ? '—' : OUTCOME_LABELS[item.outcome]}</dd>
      {item.reason === null ? null : (
        <>
          <dt className="text-muted-foreground">Reason</dt>
          <dd className="font-mono">{item.reason}</dd>
        </>
      )}
      <dt className="text-muted-foreground">Source</dt>
      <dd>
        {item.source === null ? 'Deleted source' : `${item.source.name} (${KIND_LABELS[item.source.kind]})`}
        {item.sourceEvent === null ? '' : ` · ${item.sourceEvent}`}
      </dd>
    </>
  );
}

const resultKey = (result: ActivityChannelResultDto) =>
  result.kind === ActivityChannelResultKinds.delivery ? result.delivery.id : (result.channelId ?? '');

function ItemDetails({ item }: { item: ActivityItemDto }) {
  const isReceipt = item.kind === ActivityItemKinds.receipt;
  return (
    <div className="flex flex-col gap-3 bg-muted/30 px-4 py-3">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
        {isReceipt ? (
          <ReceiptFacts item={item} />
        ) : (
          <>
            <dt className="text-muted-foreground">Source</dt>
            <dd>Mocco (a governance event)</dd>
          </>
        )}
        <dt className="text-muted-foreground">Event type</dt>
        <dd className="font-mono">{item.eventType ?? 'none'}</dd>
        <dt className="text-muted-foreground">{isReceipt ? 'Received' : 'Occurred'}</dt>
        <dd>{item.occurredAt.toLocaleString()}</dd>
      </dl>
      {item.channels.length === 0 ? (
        <p className="text-xs text-muted-foreground">{noChannelsText(item)}</p>
      ) : (
        <ul aria-label="Channels" className="divide-y divide-border rounded-lg border border-border bg-background">
          {item.channels.map(result => (
            <ChannelResult key={resultKey(result)} result={result} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ActivityRow({ item }: { item: ActivityItemDto }) {
  const [open, setOpen] = useState(false);
  const detailsId = `activity-${item.id}`;
  return (
    <>
      <tr className="border-b border-border last:border-b-0">
        <td className="px-3 py-2">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-expanded={open}
            aria-controls={detailsId}
            aria-label={open ? 'Hide details' : 'Details'}
            onClick={() => {
              setOpen(value => !value);
            }}>
            {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
          </Button>
        </td>
        <td className="px-3 py-2 text-xs whitespace-nowrap text-muted-foreground">
          <Ago date={item.occurredAt} />
        </td>
        <td className="px-3 py-2 text-sm">{sourceLabel(item)}</td>
        <td className="px-3 py-2 font-mono text-xs">{item.eventType ?? item.sourceEvent ?? '—'}</td>
        <td className="px-3 py-2">
          {item.outcome === null ? (
            <StatusBadge tone={Tones.ok}>published</StatusBadge>
          ) : (
            <StatusBadge tone={OUTCOME_TONES[item.outcome]}>{OUTCOME_LABELS[item.outcome]}</StatusBadge>
          )}
        </td>
        <td className="px-3 py-2">
          <ChannelSummary item={item} />
        </td>
      </tr>
      {open ? (
        <tr id={detailsId} className="border-b border-border last:border-b-0">
          <td colSpan={6} className="p-0">
            <ItemDetails item={item} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function ActivityTable({ items }: { items: ActivityItemDto[] }) {
  if (items.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
        Nothing yet. Deliveries from your sources, and Mocco events sent to a channel, show up here.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-border text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="w-10 px-3 py-2 font-medium">
              <span className="sr-only">Details</span>
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Received
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Source
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Event
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Outcome
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Channels
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map(item => (
            <ActivityRow key={`${item.kind}-${item.id}`} item={item} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Filters({ workspaceId, filters, onFiltersChange }: Props) {
  const sourcesQuery = trpc.inbound.sources.list.useQuery({ workspaceId }, { retry: false });
  const channelsQuery = trpc.notification.channels.useQuery({ workspaceId });
  const sources = sourcesQuery.data?.sources ?? [];
  const channels = channelsQuery.data?.channels ?? [];
  const hasFilters = filters.sourceId !== undefined || filters.channelId !== undefined || filters.outcome !== undefined;

  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className={labelClass}>
        Source
        <select
          className={cn(inputClass, 'w-44')}
          value={filters.sourceId ?? ''}
          onChange={event => {
            const { value } = event.target;
            onFiltersChange({ ...filters, sourceId: value === '' ? undefined : value });
          }}>
          <option value="">All sources</option>
          {sources.map(source => (
            <option key={source.id} value={source.id}>
              {source.name}
            </option>
          ))}
        </select>
      </label>
      <label className={labelClass}>
        Channel
        <select
          className={cn(inputClass, 'w-44')}
          value={filters.channelId ?? ''}
          onChange={event => {
            const { value } = event.target;
            onFiltersChange({ ...filters, channelId: value === '' ? undefined : value });
          }}>
          <option value="">All channels</option>
          {channels.map(channel => (
            <option key={channel.id} value={channel.id}>
              {channel.name}
            </option>
          ))}
        </select>
      </label>
      <label className={labelClass}>
        Outcome
        <select
          className={cn(inputClass, 'w-36')}
          value={filters.outcome ?? ''}
          onChange={event => {
            const parsed = inboundOutcomeSchema.safeParse(event.target.value);
            onFiltersChange({ ...filters, outcome: parsed.success ? parsed.data : undefined });
          }}>
          <option value="">All outcomes</option>
          {inboundOutcomeSchema.options.map(outcome => (
            <option key={outcome} value={outcome}>
              {OUTCOME_LABELS[outcome]}
            </option>
          ))}
        </select>
      </label>
      {hasFilters ? (
        <Button
          variant="ghost"
          onClick={() => {
            onFiltersChange({});
          }}>
          Clear filters
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The Activity tab, "why didn't it arrive?": every received webhook and every Mocco event
 * that was sent somewhere, newest first. A row expands to what each channel got — the
 * delivery with its attempts, last error and next retry, or why there was none.
 */
export default function NotificationActivity({ workspaceId, filters, onFiltersChange }: Props) {
  const activityQuery = trpc.notification.activity.useInfiniteQuery(
    { workspaceId, ...filters, limit: 25 },
    { getNextPageParam: page => page.nextCursor ?? undefined, refetchInterval: POLL_MS, retry: false },
  );
  const items = activityQuery.data?.pages.flatMap(page => page.items) ?? [];

  return (
    <section aria-labelledby="notification-activity" className="flex flex-col gap-4">
      <div>
        <h2 id="notification-activity" className="text-base font-semibold">
          Activity
        </h2>
        <p className="text-sm text-muted-foreground">
          What arrived in the last 30 days and where it went. Expand a row to see why a channel got nothing.{' '}
          <Link href={Routes.notificationsGuide('troubleshooting')} className="underline underline-offset-2">
            Troubleshooting
          </Link>
        </p>
      </div>
      <Filters workspaceId={workspaceId} filters={filters} onFiltersChange={onFiltersChange} />

      {activityQuery.isPending ? <Spinner /> : null}
      {activityQuery.isError ? (
        <Notice tone={Tones.danger} title="Activity could not be loaded">
          {activityQuery.error.message}
        </Notice>
      ) : null}
      {activityQuery.isSuccess ? <ActivityTable items={items} /> : null}
      {activityQuery.hasNextPage ? (
        <div>
          <Button
            variant="outline"
            pending={activityQuery.isFetchingNextPage}
            onClick={() => {
              fireAndForget(activityQuery.fetchNextPage());
            }}>
            Load more
          </Button>
        </div>
      ) : null}
    </section>
  );
}
