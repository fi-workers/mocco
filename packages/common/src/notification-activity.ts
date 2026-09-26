import { z } from 'zod';

import { inboundKindSchema, inboundOutcomeSchema, inboundSeqCursorSchema } from './inbound';
import { deliveryStatusSchema } from './notification';

// The activity trace (notification relay design §8): "why didn't it arrive?". One row per
// received webhook (an inbound receipt) or per Mocco event that was sent somewhere, with
// what became of it on every channel of the workspace. Kept apart from ./notification and
// ./inbound because it joins both.

/** What one channel got from one event. */
export const ActivityChannelResultKinds = {
  /** A delivery exists: its status says how far it got. */
  delivery: 'delivery',
  /** No rule of the channel matched the event; `reason` says why (the fan-out's own matcher). */
  no_match: 'no_match',
  /** The channel is disabled, so the fan-out skipped it. */
  channel_disabled: 'channel_disabled',
  /** The channel was added after the event, so it was never a candidate. */
  channel_added_later: 'channel_added_later',
} as const;
export type ActivityChannelResultKind = (typeof ActivityChannelResultKinds)[keyof typeof ActivityChannelResultKinds];

const channelRef = {
  /** Null for a delivery whose channel was deleted since. */
  channelId: z.string().nullable(),
  channelName: z.string().nullable(),
};

export const activityDeliverySchema = z.object({
  id: z.string(),
  status: deliveryStatusSchema,
  attempts: z.number(),
  responseCode: z.number().nullable(),
  error: z.string().nullable(),
  nextAttemptAt: z.date().nullable(),
  sentAt: z.date().nullable(),
  createdAt: z.date(),
});
export type ActivityDeliveryDto = z.infer<typeof activityDeliverySchema>;

export const activityChannelResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal(ActivityChannelResultKinds.delivery), ...channelRef, delivery: activityDeliverySchema }),
  z.object({ kind: z.literal(ActivityChannelResultKinds.no_match), ...channelRef, reason: z.string() }),
  z.object({
    kind: z.literal(ActivityChannelResultKinds.channel_disabled),
    ...channelRef,
    reason: z.string().nullable(),
  }),
  z.object({ kind: z.literal(ActivityChannelResultKinds.channel_added_later), ...channelRef }),
]);
export type ActivityChannelResultDto = z.infer<typeof activityChannelResultSchema>;

/** Where an activity row came from: a received webhook, or an event Mocco published itself. */
export const ActivityItemKinds = {
  receipt: 'receipt',
  event: 'event',
} as const;
export type ActivityItemKind = (typeof ActivityItemKinds)[keyof typeof ActivityItemKinds];

export const activityItemSchema = z.object({
  kind: z.enum([ActivityItemKinds.receipt, ActivityItemKinds.event]),
  /** The receipt id, or the event id for a Mocco event. */
  id: z.string(),
  /** The receipt's `seq` (digit string); null for a Mocco event. */
  seq: z.string().nullable(),
  /** When the webhook was received, or when the Mocco event occurred. */
  occurredAt: z.date(),
  /** The inbound source; null for a Mocco event (or a receipt whose source is gone). */
  source: z.object({ id: z.string(), name: z.string(), kind: inboundKindSchema }).nullable(),
  /** The vendor's name for the delivery (`push`, `issue.created`), when it has one. */
  sourceEvent: z.string().nullable(),
  /** The receipt's outcome; null for a Mocco event (published by definition). */
  outcome: inboundOutcomeSchema.nullable(),
  /** Why a receipt produced no event (ignored) or was dropped (over_quota). */
  reason: z.string().nullable(),
  eventType: z.string().nullable(),
  eventId: z.string().nullable(),
  /** One entry per channel (and per delivery to a channel deleted since); empty until
   * there is an event. */
  channels: z.array(activityChannelResultSchema),
});
export type ActivityItemDto = z.infer<typeof activityItemSchema>;

/**
 * Where the next page starts. The trace merges two streams, receipts (by `seq`) and Mocco
 * events (by time, then id), so the cursor carries a position in each: absent means "from
 * the newest", null means "this stream is done".
 */
export const activityCursorSchema = z.object({
  receiptsBeforeSeq: inboundSeqCursorSchema.nullable().optional(),
  eventsBefore: z.object({ at: z.date(), id: z.uuid() }).nullable().optional(),
});
export type ActivityCursor = z.infer<typeof activityCursorSchema>;

/** Most rows one activity page returns. */
export const ACTIVITY_PAGE_MAX = 50;

export const activityQuerySchema = z.object({
  sourceId: z.uuid().optional(),
  channelId: z.uuid().optional(),
  outcome: inboundOutcomeSchema.optional(),
  cursor: activityCursorSchema.nullish(),
  limit: z.int().min(1).max(ACTIVITY_PAGE_MAX).default(25),
});
export type ActivityQuery = z.output<typeof activityQuerySchema>;

export const activityPageSchema = z.object({
  items: z.array(activityItemSchema),
  /** The next page's `cursor`, or null on the last page. */
  nextCursor: activityCursorSchema.nullable(),
});
export type ActivityPage = z.infer<typeof activityPageSchema>;

/** What this deployment can do with Discord: `installAvailable` is false when the bot
 * install env is missing (the install route answers 503). */
export const discordSetupSchema = z.object({ installAvailable: z.boolean(), botConfigured: z.boolean() });
export type DiscordSetupDto = z.infer<typeof discordSetupSchema>;
