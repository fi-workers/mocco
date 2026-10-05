// `mocco_notifications_*` — where a workspace's notifications go (its channels and their
// rules) and what became of each event (the activity trace: every channel's delivery, or
// why it got none). Read-only: connecting a channel and editing its rules change where a
// team is told about production, and a tool that does them needs the deciding machinery
// (the workspace's opt-in and a confirmation round trip) and its own design pass.
//
// Thin adapters (ADR 0025) over the services the console's `notification` router reads
// through: `ChannelService` for channels and rules, `ActivityService` for the trace.
// Notifications are workspace-level (no product to enable), so every call first goes
// through `WorkspaceScope` with the caller's own id, and every read the console allows a
// member is allowed here; the admin-only `guildChannels` (it spends the shared bot's
// Discord calls) has no tool. A channel or source of another workspace reads exactly like
// one that does not exist. Nothing here returns a channel's sealed secret, the Discord
// bot token or a rendered message body: the answers are built field by field from the
// rows, never by passing a row through.
import { inboundOutcomeSchema, inboundSeqCursorSchema } from '@mocco/common/inbound';
import { ChannelStatuses } from '@mocco/common/notification';
import { ACTIVITY_PAGE_MAX, ActivityChannelResultKinds } from '@mocco/common/notification-activity';
import { z } from 'zod';

import { InvalidCursorError, ToolUnavailableError } from '@backend/domain/mcp/errors';
import { asJson, userIdOf, workspaceArg } from '@backend/transport/mcp/tools/runs';

import type { WorkspaceScope } from '@backend/domain/mcp/WorkspaceScope';
import type { ActivityService } from '@backend/domain/notification/ActivityService';
import type { ChannelService } from '@backend/domain/notification/ChannelService';
import type { ChannelRow } from '@backend/domain/notification/repos/channel.repo';
import type { RuleRow } from '@backend/domain/notification/repos/rule.repo';
import type { ChannelStatus } from '@mocco/common/notification';
import type { ActivityChannelResultDto, ActivityCursor, ActivityItemDto } from '@mocco/common/notification-activity';
import type { McpServer } from '@modelcontextprotocol/server';

export interface NotificationToolDeps {
  /** Absent on a server that does not compose notifications; the tools then say so. */
  notifications?: Pick<ChannelService, 'listChannels' | 'listRules'>;
  /** The activity trace; absent like `notifications`. */
  notificationActivity?: Pick<ActivityService, 'list'>;
  scope: Pick<WorkspaceScope, 'resolve'>;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

const responseFormatArg = (concise: string, detailed: string) =>
  z.enum(['concise', 'detailed']).default('concise').describe(`\`concise\` is ${concise}; \`detailed\` ${detailed}.`);

const limitArg = z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT);
const afterArg = z.string().optional().describe("Cursor: the previous answer's `nextAfter`, as it was given.");

const channelStatuses = Object.values(ChannelStatuses) as [ChannelStatus, ...ChannelStatus[]];

const channelsInput = z.object({
  workspaceId: workspaceArg,
  status: z
    .enum(channelStatuses)
    .optional()
    .describe('Only `active` channels, or only `disabled` ones (the bot lost access; the reason says why).'),
  query: z.string().min(1).optional().describe('Text the channel name contains (case-insensitive).'),
  limit: limitArg,
  after: afterArg,
  responseFormat: responseFormatArg(
    'id, kind, name, status and why a disabled channel is disabled',
    'adds the Discord channel and server it posts to and when it was connected',
  ),
});

const rulesInput = z.object({
  workspaceId: workspaceArg,
  channelId: z
    .uuid()
    .optional()
    .describe(
      "Only this channel's rules, as `mocco_notifications_channels_search` returns it. Omit it for every channel.",
    ),
  eventType: z
    .string()
    .min(1)
    .optional()
    .describe("Text the rule's event type contains (case-insensitive), e.g. `vercel` or `gate.pending`."),
  sourceId: z.uuid().optional().describe('Only rules bound to this inbound source.'),
  limit: limitArg,
  after: afterArg,
  responseFormat: responseFormatArg(
    'id, channel, event type, source and filter of each rule',
    "adds the channel's status and when the rule was added",
  ),
});

const activityInput = z.object({
  workspaceId: workspaceArg,
  sourceId: z
    .uuid()
    .optional()
    .describe("Only what this inbound source received (Mocco's own events have no source, so they drop out)."),
  channelId: z.uuid().optional().describe('Only what this channel got (or why it got nothing).'),
  outcome: inboundOutcomeSchema
    .optional()
    .describe(
      'Only received webhooks with this outcome: `published`, `ignored` (nothing to send), `over_quota` or `pending`.',
    ),
  limit: z.number().int().min(1).max(ACTIVITY_PAGE_MAX).default(DEFAULT_LIMIT),
  cursor: z.string().optional().describe("Cursor: the previous answer's `nextCursor`, as it was given."),
  responseFormat: responseFormatArg(
    'when, from which source, the event type and outcome, and per channel what it got (sent, failed, no matching rule, …) with the error or reason',
    "adds the receipt's sequence number, the vendor's event name, the event id, and each delivery's attempts, response code and retry time",
  ),
});

export type SearchNotificationChannelsArgs = z.infer<typeof channelsInput>;
export type SearchNotificationRulesArgs = z.infer<typeof rulesInput>;
export type SearchNotificationActivityArgs = z.infer<typeof activityInput>;

function requireNotifications(deps: NotificationToolDeps) {
  if (deps.notifications === undefined) {
    throw new ToolUnavailableError('Notifications are not available on this Mocco server');
  }
  return deps.notifications;
}

function requireActivity(deps: NotificationToolDeps) {
  if (deps.notificationActivity === undefined) {
    throw new ToolUnavailableError('The notification activity trace is not available on this Mocco server');
  }
  return deps.notificationActivity;
}

/** Where a row sits in oldest-first order (the console's order), as a string that sorts the same way. */
const positionOf = (row: { createdAt: Date; id: string }) => `${row.createdAt.toISOString()}~${row.id}`;

/** Compares positions by code unit, which is the order `after` filters by. */
function oldestFirst(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/** Oldest first after `after`, one page of `limit`, and the cursor for the next page when there is one. */
export function pageOf<T extends { createdAt: Date; id: string }>(
  rows: readonly T[],
  args: { limit: number; after?: string },
) {
  const rest = rows
    .map(row => ({ row, position: positionOf(row) }))
    .filter(({ position }) => args.after === undefined || position > args.after)
    .toSorted((a, b) => oldestFirst(a.position, b.position));
  const page = rest.slice(0, args.limit);
  return {
    rows: page.map(({ row }) => row),
    // Present when there is more: pass it back as `after` for the next page.
    ...(rest.length > page.length && { nextAfter: page.at(-1)?.position }),
  };
}

export async function searchNotificationChannels(
  deps: NotificationToolDeps,
  args: SearchNotificationChannelsArgs,
  userId: string,
) {
  const notifications = requireNotifications(deps);
  const workspaceId = await deps.scope.resolve(userId, args.workspaceId);
  const channels = await notifications.listChannels(workspaceId);
  const needle = args.query?.toLowerCase();
  const matching = channels.filter(
    channel =>
      (args.status === undefined || channel.status === args.status) &&
      (needle === undefined || channel.name.toLowerCase().includes(needle)),
  );
  const { rows, ...more } = pageOf(matching, args);
  const isDetailed = args.responseFormat === 'detailed';
  return {
    channels: rows.map(channel => ({
      id: channel.id,
      kind: channel.kind,
      name: channel.name,
      status: channel.status,
      disabledReason: channel.disabledReason,
      ...(isDetailed && {
        discord: {
          serverId: channel.config.guildId,
          channelId: channel.config.channelId,
          channelName: channel.config.channelName,
        },
        createdAt: channel.createdAt,
        updatedAt: channel.updatedAt,
      }),
    })),
    ...more,
  };
}

/** The channels a rule search reads: the named one, or every channel of the workspace. */
async function rulesOf(
  notifications: NonNullable<NotificationToolDeps['notifications']>,
  workspaceId: string,
  channelId: string | undefined,
): Promise<{ channels: ChannelRow[]; rules: RuleRow[] }> {
  const channels = await notifications.listChannels(workspaceId);
  if (channelId !== undefined) {
    // The service looks the channel up inside the workspace: another workspace's channel
    // is refused exactly like one that does not exist.
    return { channels, rules: await notifications.listRules(workspaceId, channelId) };
  }
  const listed = await Promise.all(
    channels.map(async channel => await notifications.listRules(workspaceId, channel.id)),
  );
  return { channels, rules: listed.flat() };
}

export async function searchNotificationRules(
  deps: NotificationToolDeps,
  args: SearchNotificationRulesArgs,
  userId: string,
) {
  const notifications = requireNotifications(deps);
  const workspaceId = await deps.scope.resolve(userId, args.workspaceId);
  const { channels, rules } = await rulesOf(notifications, workspaceId, args.channelId);
  const byId = new Map(channels.map(channel => [channel.id, channel]));
  const needle = args.eventType?.toLowerCase();
  const matching = rules.filter(
    rule =>
      (needle === undefined || rule.eventType.toLowerCase().includes(needle)) &&
      (args.sourceId === undefined || rule.sourceId === args.sourceId),
  );
  const { rows, ...more } = pageOf(matching, args);
  const isDetailed = args.responseFormat === 'detailed';
  return {
    rules: rows.map(rule => {
      const channel = byId.get(rule.channelId);
      return {
        id: rule.id,
        channel: {
          id: rule.channelId,
          name: channel?.name ?? null,
          ...(isDetailed && { status: channel?.status ?? null }),
        },
        eventType: rule.eventType,
        sourceId: rule.sourceId,
        filter: rule.filter,
        ...(isDetailed && { createdAt: rule.createdAt }),
      };
    }),
    ...more,
  };
}

// The trace merges two streams, so its cursor holds a position in each. It travels as
// one opaque string, parsed back here before the service sees it: a cursor the tool did
// not hand out is refused, never passed through.
const wireCursorSchema = z.object({
  receiptsBeforeSeq: inboundSeqCursorSchema.nullable().optional(),
  eventsBefore: z.object({ at: z.iso.datetime(), id: z.uuid() }).nullable().optional(),
});

function encodeCursor(cursor: ActivityCursor): string {
  const { receiptsBeforeSeq, eventsBefore } = cursor;
  const wire = {
    receiptsBeforeSeq,
    eventsBefore:
      eventsBefore === null || eventsBefore === undefined
        ? eventsBefore
        : { ...eventsBefore, at: eventsBefore.at.toISOString() },
  };
  // Buffer is the available base64url codec (see infra/crypto/secret-box.ts).
  // eslint-disable-next-line unicorn/prefer-uint8array-base64
  return Buffer.from(JSON.stringify(wire)).toString('base64url');
}

/** The service's cursor; an empty one (from the newest) when none was passed. */
function decodeCursor(cursor: string | undefined): ActivityCursor {
  if (cursor === undefined) {
    return {};
  }
  let parsed: unknown;
  try {
    // eslint-disable-next-line unicorn/prefer-uint8array-base64
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch (error) {
    throw new InvalidCursorError({ cause: error });
  }
  const wire = wireCursorSchema.safeParse(parsed);
  if (!wire.success) {
    throw new InvalidCursorError({ cause: wire.error });
  }
  const { receiptsBeforeSeq, eventsBefore } = wire.data;
  return {
    ...(receiptsBeforeSeq !== undefined && { receiptsBeforeSeq }),
    ...(eventsBefore !== undefined && {
      eventsBefore: eventsBefore === null ? null : { at: new Date(eventsBefore.at), id: eventsBefore.id },
    }),
  };
}

/** What one channel got, in a word, and the one line that explains it. */
function conciseResult(result: ActivityChannelResultDto) {
  let summary: { result: string; reason: string | null };
  switch (result.kind) {
    case ActivityChannelResultKinds.delivery: {
      summary = { result: result.delivery.status, reason: result.delivery.error };
      break;
    }
    case ActivityChannelResultKinds.no_match:
    case ActivityChannelResultKinds.channel_disabled: {
      summary = { result: result.kind, reason: result.reason };
      break;
    }
    case ActivityChannelResultKinds.channel_added_later: {
      summary = { result: result.kind, reason: null };
      break;
    }
    default: {
      const unexpected: never = result;
      throw new Error(`unexpected activity result ${JSON.stringify(unexpected)}`);
    }
  }
  return { channelId: result.channelId, channelName: result.channelName, ...summary };
}

/** One trace row in a few words per channel. */
const conciseItem = (item: ActivityItemDto) => ({
  kind: item.kind,
  id: item.id,
  occurredAt: item.occurredAt,
  source: item.source?.name ?? null,
  eventType: item.eventType,
  outcome: item.outcome,
  reason: item.reason,
  channels: item.channels.map(result => conciseResult(result)),
});

/** One trace row as the service answers it: every field of it is safe to show a member. */
const detailedItem = (item: ActivityItemDto) => ({
  kind: item.kind,
  id: item.id,
  seq: item.seq,
  occurredAt: item.occurredAt,
  source: item.source,
  sourceEvent: item.sourceEvent,
  eventType: item.eventType,
  eventId: item.eventId,
  outcome: item.outcome,
  reason: item.reason,
  channels: item.channels,
});

export async function searchNotificationActivity(
  deps: NotificationToolDeps,
  args: SearchNotificationActivityArgs,
  userId: string,
) {
  const activity = requireActivity(deps);
  const workspaceId = await deps.scope.resolve(userId, args.workspaceId);
  const page = await activity.list(workspaceId, {
    limit: args.limit,
    ...(args.sourceId !== undefined && { sourceId: args.sourceId }),
    ...(args.channelId !== undefined && { channelId: args.channelId }),
    ...(args.outcome !== undefined && { outcome: args.outcome }),
    cursor: decodeCursor(args.cursor),
  });
  const isDetailed = args.responseFormat === 'detailed';
  return {
    items: isDetailed ? page.items.map(item => detailedItem(item)) : page.items.map(item => conciseItem(item)),
    // Present when there is more: pass it back as `cursor` for the next page.
    ...(page.nextCursor !== null && { nextCursor: encodeCursor(page.nextCursor) }),
  };
}

export function registerNotificationTools(server: McpServer, deps: NotificationToolDeps): void {
  server.registerTool(
    'mocco_notifications_channels_search',
    {
      title: 'Find notification channels',
      description:
        "The workspace's notification channels (Discord channels Mocco posts to), oldest first: whether each is active or disabled and why. Never returns a token or secret. Read-only.",
      inputSchema: channelsInput,
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => asJson(await searchNotificationChannels(deps, args, userIdOf(ctx))),
  );

  server.registerTool(
    'mocco_notifications_rules_search',
    {
      title: 'Find notification rules',
      description:
        "Which events go to which channel: each rule names an event type (exact, or a prefix like `github.*`), optionally one inbound source, and a filter every key of which must equal the event's fact. Read-only.",
      inputSchema: rulesInput,
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => asJson(await searchNotificationRules(deps, args, userIdOf(ctx))),
  );

  server.registerTool(
    'mocco_notifications_activity_search',
    {
      title: 'Trace notifications',
      description:
        'The activity trace, newest first: each webhook an inbound source received and each Mocco event sent somewhere, with what every channel got — a delivery and its status and error, or why none (no matching rule, channel disabled, channel added later). Answers "why didn\'t it arrive?". Read-only.',
      inputSchema: activityInput,
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => asJson(await searchNotificationActivity(deps, args, userIdOf(ctx))),
  );
}
