import { z } from 'zod';

/**
 * How loud a notification is. Senders map it to their own presentation (the
 * Discord sender picks the embed color and emoji from it); producers never pick
 * colors themselves.
 */
export const Severities = {
  info: 'info',
  success: 'success',
  warning: 'warning',
  error: 'error',
} as const;
export type Severity = (typeof Severities)[keyof typeof Severities];
export const severitySchema = z.enum(Object.values(Severities) as [Severity, ...Severity[]]);

/**
 * Size limits of a `NeutralMessage`. They match the tightest sender we deliver
 * to (Discord embeds), so a message that parses here renders without being cut
 * by the sender.
 */
export const NeutralMessageLimits = {
  title: 256,
  description: 2000,
  fields: 10,
  fieldName: 256,
  fieldValue: 1024,
  footer: 2048,
  actorName: 256,
  /** Discord's cap on the characters of one embed, summed over every text part. */
  total: 6000,
} as const;

export const neutralMessageFieldSchema = z.object({
  name: z.string().min(1).max(NeutralMessageLimits.fieldName),
  value: z.string().min(1).max(NeutralMessageLimits.fieldValue),
  inline: z.boolean().optional(),
});
export type NeutralMessageField = z.infer<typeof neutralMessageFieldSchema>;

export const neutralMessageActorSchema = z.object({
  name: z.string().min(1).max(NeutralMessageLimits.actorName),
  url: z.url().optional(),
  avatarUrl: z.url().optional(),
});
export type NeutralMessageActor = z.infer<typeof neutralMessageActorSchema>;

/**
 * A sender-agnostic notification, rendered once when an event is recorded. It
 * carries content only (text, links, severity); presentation belongs to the
 * sender that delivers it.
 */
const neutralMessageShape = z.object({
  title: z.string().min(1).max(NeutralMessageLimits.title),
  url: z.url().optional(),
  description: z.string().max(NeutralMessageLimits.description).optional(),
  severity: severitySchema,
  fields: z.array(neutralMessageFieldSchema).max(NeutralMessageLimits.fields),
  actor: neutralMessageActorSchema.optional(),
  footer: z.string().min(1).max(NeutralMessageLimits.footer),
});

type NeutralMessageText = Pick<z.infer<typeof neutralMessageShape>, 'title' | 'description' | 'fields' | 'footer'> & {
  actor?: { name: string };
};

/** Characters counted against `NeutralMessageLimits.total`: every text part a sender renders. */
export function neutralMessageLength(message: NeutralMessageText): number {
  const fields = message.fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0);
  return (
    message.title.length +
    (message.description?.length ?? 0) +
    fields +
    message.footer.length +
    (message.actor?.name.length ?? 0)
  );
}

export const neutralMessageSchema = neutralMessageShape.superRefine((message, context) => {
  const length = neutralMessageLength(message);
  if (length > NeutralMessageLimits.total) {
    context.addIssue({
      code: 'custom',
      message: `message is ${length} characters, over the ${NeutralMessageLimits.total} total`,
    });
  }
});
export type NeutralMessage = z.infer<typeof neutralMessageSchema>;

/** Where a notification channel delivers. Discord first (relay design §2 #8); Slack later. */
export const ChannelKinds = {
  discord: 'discord',
} as const;
export type ChannelKind = (typeof ChannelKinds)[keyof typeof ChannelKinds];
export const channelKindSchema = z.enum(Object.values(ChannelKinds) as [ChannelKind, ...ChannelKind[]]);

/** A disabled channel receives nothing until it is re-enabled (e.g. the bot lost access). */
export const ChannelStatuses = {
  active: 'active',
  disabled: 'disabled',
} as const;
export type ChannelStatus = (typeof ChannelStatuses)[keyof typeof ChannelStatuses];
export const channelStatusSchema = z.enum(Object.values(ChannelStatuses) as [ChannelStatus, ...ChannelStatus[]]);

/**
 * A delivery's lifecycle: `queued` until a run claims it (`sending`, while the
 * sender is called), then `sent` or `failed` from the answer, or back to `queued`
 * to wait; `suppressed` when there is nothing left to send to (the channel was
 * deleted before the delivery ran).
 */
export const DeliveryStatuses = {
  queued: 'queued',
  sending: 'sending',
  sent: 'sent',
  failed: 'failed',
  suppressed: 'suppressed',
} as const;
export type DeliveryStatus = (typeof DeliveryStatuses)[keyof typeof DeliveryStatuses];
export const deliveryStatusSchema = z.enum(Object.values(DeliveryStatuses) as [DeliveryStatus, ...DeliveryStatus[]]);

/** The non-secret settings of a Discord channel (`mocco_notification_channels.config`). */
export const discordChannelConfigSchema = z.object({
  guildId: z.string().min(1),
  channelId: z.string().min(1),
  channelName: z.string(),
});
export type DiscordChannelConfig = z.infer<typeof discordChannelConfigSchema>;

/**
 * A rule's filter: every key must equal the event's fact of the same name
 * (relay design §7). Flat equality only; no expression language in v1.
 */
export const ruleFilterSchema = z.record(z.string(), z.union([z.string(), z.boolean()]));
export type RuleFilter = z.infer<typeof ruleFilterSchema>;

/**
 * An event type a rule can name: an exact type (`vercel.deployment.error`) or a
 * dotted prefix wildcard (`github.*`, `github.pull_request.*`). Whether an exact
 * type is known is checked by the service against the catalog.
 */
export const ruleEventTypeSchema = z
  .string()
  .regex(
    /^[a-z][a-z_]*(?:\.[a-z][a-z_]*)*(?:\.\*)?$/u,
    'an event type like `gate.pending` or a prefix like `github.*`',
  );

// Wire shapes of the `notification` tRPC router. `z.object` strips unknown keys at
// runtime, so a repo row passed through `.output()` loses every column not listed
// here (`secret_sealed`, `external_id`, the workspace id).

export const discordGuildSchema = z.object({
  id: z.string(),
  guildId: z.string(),
  guildName: z.string(),
  createdAt: z.date(),
});
export type DiscordGuildDto = z.infer<typeof discordGuildSchema>;

export const discordTextChannelSchema = z.object({ id: z.string(), name: z.string(), type: z.number() });
export type DiscordTextChannelDto = z.infer<typeof discordTextChannelSchema>;

export const notificationChannelSchema = z.object({
  id: z.string(),
  kind: channelKindSchema,
  name: z.string(),
  config: discordChannelConfigSchema,
  status: channelStatusSchema,
  disabledReason: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type NotificationChannelDto = z.infer<typeof notificationChannelSchema>;

/** The test message sent when a channel is created: shown right away, so a missing
 * permission surfaces at setup instead of on the first real event. */
export const channelTestResultSchema = z.object({
  sent: z.boolean(),
  reason: z.string().nullable(),
  /** The bot cannot reach the channel; it was created disabled. */
  channelDisabled: z.boolean(),
});
export type ChannelTestResult = z.infer<typeof channelTestResultSchema>;

export const notificationRuleSchema = z.object({
  id: z.string(),
  channelId: z.string(),
  eventType: z.string(),
  sourceId: z.string().nullable(),
  filter: ruleFilterSchema,
  createdAt: z.date(),
});
export type NotificationRuleDto = z.infer<typeof notificationRuleSchema>;

export const notificationDeliverySchema = z.object({
  id: z.string(),
  channelId: z.string().nullable(),
  eventId: z.string(),
  ruleId: z.string().nullable(),
  status: deliveryStatusSchema,
  attempts: z.number(),
  responseCode: z.number().nullable(),
  error: z.string().nullable(),
  externalMessageId: z.string().nullable(),
  message: neutralMessageShape,
  nextAttemptAt: z.date().nullable(),
  sentAt: z.date().nullable(),
  /** A stage0 canary (Mocco's own watchdog): the trace hides or labels it. */
  canary: z.boolean(),
  createdAt: z.date(),
});
export type NotificationDeliveryDto = z.infer<typeof notificationDeliverySchema>;

/** Most deliveries one `deliveries` read returns. */
export const DELIVERY_LIST_MAX = 100;
