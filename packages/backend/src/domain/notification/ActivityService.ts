import { InboundOutcomes } from '@mocco/common/inbound';
import { ChannelStatuses } from '@mocco/common/notification';
import { ActivityChannelResultKinds, ActivityItemKinds } from '@mocco/common/notification-activity';

import { explainNoMatch, parseMatchableEvent } from '@backend/domain/notification/rules';

import type { InboundReceiptRepo, InboundReceiptRow } from '@backend/domain/inbound/repos/inbound-receipt.repo';
import type { InboundSourceRepo, InboundSourceRow } from '@backend/domain/inbound/repos/inbound-source.repo';
import type { ChannelRepo, ChannelRow } from '@backend/domain/notification/repos/channel.repo';
import type { DeliveredEventRow, DeliveryRepo, DeliveryRow } from '@backend/domain/notification/repos/delivery.repo';
import type { RuleRepo, RuleRow } from '@backend/domain/notification/repos/rule.repo';
import type {
  ActivityChannelResultDto,
  ActivityCursor,
  ActivityItemDto,
  ActivityPage,
  ActivityQuery,
} from '@mocco/common/notification-activity';

export interface ActivityServiceDeps {
  receipts: Pick<InboundReceiptRepo, 'listByWorkspace'>;
  sources: Pick<InboundSourceRepo, 'listByWorkspace'>;
  channels: Pick<ChannelRepo, 'findByWorkspace'>;
  rules: Pick<RuleRepo, 'findByWorkspace'>;
  deliveries: Pick<DeliveryRepo, 'findByEventIds' | 'findDeliveredEvents'>;
}

/** One row of either stream, before it is enriched with its channels. */
type StreamEntry =
  | { kind: typeof ActivityItemKinds.receipt; at: Date; receipt: InboundReceiptRow }
  | { kind: typeof ActivityItemKinds.event; at: Date; event: DeliveredEventRow };

/** What the trace knows about one event: its id, type and payload, and when it happened. */
interface TracedEvent {
  id: string;
  type: string;
  payload: unknown;
  occurredAt: Date;
}

interface Workspace {
  channels: ChannelRow[];
  rulesByChannel: Map<string, RuleRow[]>;
  deliveriesByEvent: Map<string, DeliveryRow[]>;
  sourcesById: Map<string, InboundSourceRow>;
  /** Only this channel's results, when the trace is filtered by channel. */
  channelId?: string;
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  return rows.reduce((groups, row) => {
    const k = key(row);
    return groups.set(k, [...(groups.get(k) ?? []), row]);
  }, new Map<string, T[]>());
}

function toDelivery(delivery: DeliveryRow) {
  return {
    id: delivery.id,
    status: delivery.status,
    attempts: delivery.attempts,
    responseCode: delivery.responseCode,
    error: delivery.error,
    nextAttemptAt: delivery.nextAttemptAt,
    sentAt: delivery.sentAt,
    createdAt: delivery.createdAt,
  };
}

/**
 * What every channel got from `event`: its delivery; or, without one, why not: the channel
 * is disabled, was added after the event, or none of its rules match (explained by the same
 * pure matcher the fan-out decides with, over the channel's current rules). Deliveries to
 * channels deleted since are listed too, without a channel.
 */
function channelResults(event: TracedEvent, ws: Workspace): ActivityChannelResultDto[] {
  const deliveries = ws.deliveriesByEvent.get(event.id) ?? [];
  const channels = ws.channelId === undefined ? ws.channels : ws.channels.filter(({ id }) => id === ws.channelId);
  const matchable = parseMatchableEvent(event.type, event.payload);
  // eslint-disable-next-line sonarjs/function-return-type -- each branch is one member of the result union
  const results = channels.map((channel): ActivityChannelResultDto => {
    const ref = { channelId: channel.id, channelName: channel.name };
    const delivery = deliveries.find(candidate => candidate.channelId === channel.id);
    if (delivery !== undefined) {
      return { kind: ActivityChannelResultKinds.delivery, ...ref, delivery: toDelivery(delivery) };
    }
    if (channel.createdAt.getTime() > event.occurredAt.getTime()) {
      return { kind: ActivityChannelResultKinds.channel_added_later, ...ref };
    }
    if (channel.status === ChannelStatuses.disabled) {
      return { kind: ActivityChannelResultKinds.channel_disabled, ...ref, reason: channel.disabledReason };
    }
    const reason =
      matchable === undefined
        ? 'the event can no longer be read'
        : explainNoMatch(ws.rulesByChannel.get(channel.id) ?? [], matchable);
    return { kind: ActivityChannelResultKinds.no_match, ...ref, reason };
  });
  const orphans =
    ws.channelId === undefined
      ? deliveries
          .filter(delivery => delivery.channelId === null)
          .map((delivery): ActivityChannelResultDto => ({
            kind: ActivityChannelResultKinds.delivery,
            channelId: null,
            channelName: null,
            delivery: toDelivery(delivery),
          }))
      : [];
  return [...results, ...orphans];
}

function receiptItem(receipt: InboundReceiptRow, ws: Workspace): ActivityItemDto {
  const source = ws.sourcesById.get(receipt.sourceId);
  const { domainEventId: eventId, eventType } = receipt;
  return {
    kind: ActivityItemKinds.receipt,
    id: receipt.id,
    seq: receipt.seq.toString(),
    occurredAt: receipt.receivedAt,
    source: source === undefined ? null : { id: source.id, name: source.name, kind: source.kind },
    sourceEvent: receipt.sourceEvent,
    outcome: receipt.outcome,
    reason: receipt.reason,
    eventType: receipt.eventType,
    eventId,
    // The receipt keeps the event payload (`normalized`), so the explanation needs no
    // read of the event itself; its deliveries are found by the event id.
    channels:
      receipt.outcome === InboundOutcomes.published && eventId !== null && eventType !== null
        ? channelResults(
            { id: eventId, type: eventType, payload: receipt.normalized, occurredAt: receipt.receivedAt },
            ws,
          )
        : [],
  };
}

function eventItem(event: DeliveredEventRow, ws: Workspace): ActivityItemDto {
  return {
    kind: ActivityItemKinds.event,
    id: event.id,
    seq: null,
    occurredAt: event.occurredAt,
    source: null,
    sourceEvent: null,
    outcome: null,
    reason: null,
    eventType: event.type,
    eventId: event.id,
    channels: channelResults(event, ws),
  };
}

/**
 * Merge the two streams newest first, keeping each stream's own order (a receipt's `seq`
 * order is the one its cursor resumes from), and stop at `limit` rows.
 */
function mergeNewestFirst(
  receipts: readonly InboundReceiptRow[],
  events: readonly DeliveredEventRow[],
  limit: number,
): StreamEntry[] {
  const merged: StreamEntry[] = [];
  let r = 0;
  let e = 0;
  while (merged.length < limit && (r < receipts.length || e < events.length)) {
    const receipt = receipts[r];
    const event = events[e];
    if (receipt !== undefined && (event === undefined || receipt.receivedAt.getTime() >= event.occurredAt.getTime())) {
      merged.push({ kind: ActivityItemKinds.receipt, at: receipt.receivedAt, receipt });
      r += 1;
    } else if (event !== undefined) {
      merged.push({ kind: ActivityItemKinds.event, at: event.occurredAt, event });
      e += 1;
    }
  }
  return merged;
}

/**
 * Each stream is done when it was closed already, or it returned fewer than `limit` rows
 * and all of them made the page; otherwise it resumes after the last row the page took
 * (or where it was, when the page took none of its rows).
 */
// eslint-disable-next-line sonarjs/function-return-type -- null marks the last page
function cursorAfter(
  cursor: ActivityCursor,
  streams: {
    receipts: { open: boolean; fetched: number; taken: InboundReceiptRow[] };
    events: { open: boolean; fetched: number; taken: DeliveredEventRow[] };
    limit: number;
  },
): ActivityCursor | null {
  const { receipts, events, limit } = streams;
  const isDone = (stream: { open: boolean; fetched: number; taken: unknown[] }) =>
    !stream.open || (stream.fetched < limit && stream.taken.length === stream.fetched);
  const isReceiptsDone = isDone(receipts);
  const isEventsDone = isDone(events);
  if (isReceiptsDone && isEventsDone) {
    return null;
  }
  const lastReceipt = receipts.taken.at(-1);
  const lastEvent = events.taken.at(-1);
  const eventsAfter = lastEvent === undefined ? cursor.eventsBefore : { at: lastEvent.occurredAt, id: lastEvent.id };
  return {
    receiptsBeforeSeq: isReceiptsDone ? null : (lastReceipt?.seq.toString() ?? cursor.receiptsBeforeSeq),
    eventsBefore: isEventsDone ? null : eventsAfter,
  };
}

/**
 * The activity trace (notification relay design §8): what arrived and where it went.
 * Two streams are merged newest first: the workspace's inbound receipts (by `seq`) and the
 * Mocco events that were delivered to at least one channel (by time). A page takes up to
 * `limit` rows from each, merges them, keeps the newest `limit`, and the cursor records how
 * far each stream got, so no row is skipped or repeated across pages.
 */
export class ActivityService {
  constructor(private readonly deps: ActivityServiceDeps) {}

  async list(workspaceId: string, query: ActivityQuery): Promise<ActivityPage> {
    const cursor: ActivityCursor = query.cursor ?? {};
    const { limit } = query;
    // Mocco events have no source and are published by definition.
    const hasEventStream =
      query.sourceId === undefined && (query.outcome === undefined || query.outcome === InboundOutcomes.published);
    const { receiptsBeforeSeq } = cursor;
    const isReceiptsOpen = receiptsBeforeSeq !== null;
    const isEventsOpen = hasEventStream && cursor.eventsBefore !== null;

    const [receipts, events] = await Promise.all([
      receiptsBeforeSeq === null
        ? []
        : this.deps.receipts.listByWorkspace(workspaceId, {
            sourceId: query.sourceId,
            outcome: query.outcome,
            beforeSeq: receiptsBeforeSeq === undefined ? undefined : BigInt(receiptsBeforeSeq),
            limit,
          }),
      isEventsOpen
        ? this.deps.deliveries.findDeliveredEvents(workspaceId, {
            channelId: query.channelId,
            before: cursor.eventsBefore ?? undefined,
            limit,
          })
        : [],
    ]);

    const merged = mergeNewestFirst(receipts, events, limit);
    const pageReceipts = merged.flatMap(entry => (entry.kind === ActivityItemKinds.receipt ? [entry.receipt] : []));
    const pageEvents = merged.flatMap(entry => (entry.kind === ActivityItemKinds.event ? [entry.event] : []));
    const nextCursor = cursorAfter(cursor, {
      receipts: { open: isReceiptsOpen, fetched: receipts.length, taken: pageReceipts },
      events: { open: isEventsOpen, fetched: events.length, taken: pageEvents },
      limit,
    });

    const eventIds = [
      ...pageReceipts.flatMap(receipt => (receipt.domainEventId === null ? [] : [receipt.domainEventId])),
      ...pageEvents.map(event => event.id),
    ];
    const [channels, rules, deliveries, sources] = await Promise.all([
      this.deps.channels.findByWorkspace(workspaceId),
      this.deps.rules.findByWorkspace(workspaceId),
      this.deps.deliveries.findByEventIds(workspaceId, eventIds),
      this.deps.sources.listByWorkspace(workspaceId),
    ]);
    const ws: Workspace = {
      channels,
      rulesByChannel: groupBy(rules, rule => rule.channelId),
      deliveriesByEvent: groupBy(deliveries, delivery => delivery.eventId),
      sourcesById: new Map(sources.map(source => [source.id, source])),
      ...(query.channelId !== undefined && { channelId: query.channelId }),
    };

    const items = merged.map(entry =>
      entry.kind === ActivityItemKinds.receipt ? receiptItem(entry.receipt, ws) : eventItem(entry.event, ws),
    );
    return { items, nextCursor };
  }
}
