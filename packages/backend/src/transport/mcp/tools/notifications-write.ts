// The tools that change where a workspace's notifications go: connect a Discord channel,
// turn a disabled one back on, add and remove rules, and apply a preset. Plus the one read
// connecting needs: the text channels of the workspace's Discord server, as the bot sees
// them.
//
// They change where a team hears about production, so they take the same locks as the
// deciding tools (`tools/deciding.ts`): the `approvals:write` scope, the workspace's
// opt-in, and a confirmation the person answers in their client, showing exactly what
// would change. Then the console's own rule: only an owner or admin may change
// notification settings (`WorkspaceScope.requireAdmin`, the check the console's
// `adminNotificationProcedure` makes, read by user id because MCP has a token and no
// session), and a plain member is refused before being asked anything.
//
// Thin adapters (ADR 0025) over `ChannelService`, the service the console's
// `notification` router writes through. The service records every change in the audit
// log as the person who made it, so a change made through an agent reads like one made
// in the console. Answers are built field by field: no sealed secret, bot token or
// rendered message reaches them.
import { ruleEventTypeSchema, ruleFilterSchema } from '@mocco/common/notification';
import { rulePresetRules, RulePresets, rulePresetSchema } from '@mocco/common/notification-presets';
import { z } from 'zod';

import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '@backend/domain/errors';
import { DiscordServerUnclearError, ToolUnavailableError } from '@backend/domain/mcp/errors';
import {
  DiscordChannelNotInGuildError,
  NotificationChannelNotFoundError,
  NotificationRuleNotFoundError,
} from '@backend/domain/notification/errors';
import { confirmThenApply, openDecision, refused, requireApprovalsWrite } from '@backend/transport/mcp/tools/deciding';
import { asJson, userIdOf, workspaceArg } from '@backend/transport/mcp/tools/runs';

import type { WorkspaceScope } from '@backend/domain/mcp/WorkspaceScope';
import type { ChannelService } from '@backend/domain/notification/ChannelService';
import type { ChannelRow } from '@backend/domain/notification/repos/channel.repo';
import type { RuleRow } from '@backend/domain/notification/repos/rule.repo';
import type { DecidingToolDeps } from '@backend/transport/mcp/tools/deciding';
import type { ChannelTestResult, RuleFilter } from '@mocco/common/notification';
import type { RulePreset } from '@mocco/common/notification-presets';
import type { CallToolResult, InputRequiredResult, McpServer, ServerContext } from '@modelcontextprotocol/server';

export interface NotificationWriteToolDeps extends DecidingToolDeps {
  /** Absent on a server that does not compose notifications; the tools then say so. */
  notifications?: Pick<
    ChannelService,
    | 'listGuilds'
    | 'listGuildChannels'
    | 'listChannels'
    | 'listRules'
    | 'createChannel'
    | 'reenableChannel'
    | 'addRule'
    | 'removeRule'
    | 'applyDefaultRules'
  >;
  scope: WorkspaceScope;
}

type Notifications = NonNullable<NotificationWriteToolDeps['notifications']>;

export const NotificationWriteTools = {
  discordChannels: 'mocco_notifications_discord_channels_search',
  connect: 'mocco_notifications_channels_connect',
  reenable: 'mocco_notifications_channels_reenable',
  addRule: 'mocco_notifications_rules_add',
  removeRule: 'mocco_notifications_rules_remove',
  applyPreset: 'mocco_notifications_presets_apply',
} as const;

/** How the tools name what they do, in the opt-in refusals. */
const WORDS = { verb: 'change notification settings', doing: 'Changing notification settings' };

const DISCORD_CHANNELS_MAX = 100;

const guildArg = z
  .uuid()
  .optional()
  .describe(
    'The Discord server, as `mocco_notifications_discord_channels_search` names it. Omit it when the workspace has one.',
  );
const channelArg = z.uuid().describe('The notification channel, as `mocco_notifications_channels_search` returns it.');

const discordChannelsInput = z.object({
  workspaceId: workspaceArg,
  guildId: guildArg,
  query: z.string().min(1).optional().describe('Text the Discord channel name contains (case-insensitive).'),
  limit: z.number().int().min(1).max(DISCORD_CHANNELS_MAX).default(50),
  after: z.string().optional().describe("Cursor: the previous answer's `nextAfter`, as it was given."),
});

const connectInput = z.object({
  workspaceId: workspaceArg,
  guildId: guildArg,
  discordChannelId: z
    .string()
    .regex(/^\d{1,20}$/u)
    .describe('The Discord channel id, as `mocco_notifications_discord_channels_search` returns it.'),
  name: z.string().trim().min(1).max(100).optional().describe('The name shown in Mocco. Defaults to `#<channel>`.'),
});

const reenableInput = z.object({ workspaceId: workspaceArg, channelId: channelArg });

const ruleToAddInput = z.object({
  workspaceId: workspaceArg,
  channelId: channelArg,
  eventType: ruleEventTypeSchema.describe(
    'An exact event type (`gate.pending`, `vercel.deployment.error`) or a prefix (`github.*`).',
  ),
  sourceId: z.uuid().optional().describe('Only events from this inbound source. Omit it for every source.'),
  filter: ruleFilterSchema
    .optional()
    .describe('Facts the event must have, every key equal (`{ "target": "production" }`). Omit it for none.'),
});

const ruleToRemoveInput = z.object({
  workspaceId: workspaceArg,
  ruleId: z.uuid().describe('The rule, as `mocco_notifications_rules_search` returns it.'),
});

const applyPresetInput = z.object({
  workspaceId: workspaceArg,
  channelId: channelArg,
  preset: rulePresetSchema.describe(
    "A ready set of rules: `mocco` (Mocco's own gate and run events), `sentry`, `vercel` or `github`.",
  ),
  sourceId: z
    .uuid()
    .optional()
    .describe('For a vendor preset, only events from this inbound source. The `mocco` preset ignores it.'),
});

export type DiscordChannelsArgs = z.infer<typeof discordChannelsInput>;
export type ConnectArgs = z.infer<typeof connectInput>;
export type ReenableArgs = z.infer<typeof reenableInput>;
export type AddRuleArgs = z.infer<typeof ruleToAddInput>;
export type RemoveRuleArgs = z.infer<typeof ruleToRemoveInput>;
export type ApplyPresetArgs = z.infer<typeof applyPresetInput>;

function requireNotifications(deps: NotificationWriteToolDeps): Notifications {
  if (deps.notifications === undefined) {
    throw new ToolUnavailableError('Notifications are not available on this Mocco server');
  }
  return deps.notifications;
}

/**
 * The service's refusals, as the model reads them. The service already words them for a
 * person ("Notification channel … not found"); anything outside these families is
 * rethrown, because an unexpected failure is not something to explain away.
 */
function changeRefusal(error: unknown): CallToolResult {
  if (
    error instanceof NotFoundError ||
    error instanceof ConflictError ||
    error instanceof BadRequestError ||
    error instanceof ForbiddenError
  ) {
    return refused(error.message);
  }
  throw error;
}

/** A channel as the answers show it: never its config secret or vendor id column. */
const channelSummary = (channel: ChannelRow) => ({
  id: channel.id,
  name: channel.name,
  status: channel.status,
  disabledReason: channel.disabledReason,
});

const ruleSummary = (rule: RuleRow) => ({
  id: rule.id,
  channelId: rule.channelId,
  eventType: rule.eventType,
  sourceId: rule.sourceId,
  filter: rule.filter,
});

const testSummary = (test: ChannelTestResult) => ({
  sent: test.sent,
  reason: test.reason,
  channelDisabled: test.channelDisabled,
});

function describeFilter(filter: RuleFilter): string {
  const entries = Object.entries(filter);
  return entries.length === 0 ? 'none' : entries.map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join(', ');
}

const presetLines = (preset: RulePreset) =>
  rulePresetRules[preset].map(rule =>
    Object.keys(rule.filter).length === 0
      ? `- ${rule.eventType}`
      : `- ${rule.eventType} when ${describeFilter(rule.filter)}`,
  );

/** The Discord server a call is about: the named one, or the workspace's only one. */
async function oneGuild(notifications: Notifications, workspaceId: string, guildId: string | undefined) {
  const guilds = await notifications.listGuilds(workspaceId);
  const found = guildId === undefined ? guilds : guilds.filter(guild => guild.id === guildId);
  const [only] = found;
  if (found.length !== 1 || only === undefined) {
    throw new DiscordServerUnclearError(guilds.map(guild => ({ id: guild.id, name: guild.guildName })));
  }
  return only;
}

async function channelIn(notifications: Notifications, workspaceId: string, channelId: string) {
  const channels = await notifications.listChannels(workspaceId);
  const channel = channels.find(each => each.id === channelId);
  if (channel === undefined) {
    throw new NotificationChannelNotFoundError(channelId);
  }
  return channel;
}

/**
 * The checks every changing tool makes before it asks: scope, opt-in and a signing key
 * (`openDecision`), the service being here, and the caller being an owner or admin.
 */
async function openChange(deps: NotificationWriteToolDeps, ctx: ServerContext, workspaceArgument?: string) {
  const opened = await openDecision(deps, ctx, workspaceArgument, WORDS);
  if ('content' in opened) {
    return opened;
  }
  const notifications = requireNotifications(deps);
  await deps.scope.requireAdmin(opened.userId, opened.workspaceId);
  return { ...opened, notifications };
}

/**
 * The text channels of the workspace's Discord server, as the bot lists them now, and
 * which are already connected. Owners and admins only, as in the console: listing spends
 * the shared bot's Discord calls, and the service paces them on the same rate-limit
 * buckets the console's `guildChannels` uses.
 */
export async function searchDiscordChannels(
  deps: NotificationWriteToolDeps,
  args: DiscordChannelsArgs,
  userId: string,
) {
  const notifications = requireNotifications(deps);
  const workspaceId = await deps.scope.resolve(userId, args.workspaceId);
  await deps.scope.requireAdmin(userId, workspaceId);
  const guild = await oneGuild(notifications, workspaceId, args.guildId);
  const [listed, connected] = await Promise.all([
    notifications.listGuildChannels(workspaceId, guild.id),
    notifications.listChannels(workspaceId),
  ]);
  const connectedIds = new Set(connected.map(channel => channel.config.channelId));
  const needle = args.query?.toLowerCase();
  const matching = listed.filter(channel => needle === undefined || channel.name.toLowerCase().includes(needle));
  const start = args.after === undefined ? 0 : matching.findIndex(channel => channel.id === args.after) + 1;
  const page = matching.slice(start, start + args.limit);
  return {
    server: { guildId: guild.id, name: guild.guildName },
    channels: page.map(channel => ({
      discordChannelId: channel.id,
      name: channel.name,
      isConnected: connectedIds.has(channel.id),
    })),
    // Present when there is more: pass it back as `after` for the next page.
    ...(start + page.length < matching.length && { nextAfter: page.at(-1)?.id }),
  };
}

export async function connectChannel(
  deps: NotificationWriteToolDeps,
  args: ConnectArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openChange(deps, ctx, args.workspaceId);
    if ('content' in opened) {
      return opened;
    }
    const { userId, workspaceId, confirmations, notifications } = opened;
    const guild = await oneGuild(notifications, workspaceId, args.guildId);
    const change = {
      tool: NotificationWriteTools.connect,
      workspaceId,
      guildId: guild.id,
      discordChannelId: args.discordChannelId,
      name: args.name ?? null,
    };
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Connect this channel',
      ask: async () => {
        const listed = await notifications.listGuildChannels(workspaceId, guild.id);
        const discordChannel = listed.find(each => each.id === args.discordChannelId);
        if (discordChannel === undefined) {
          // The refusal the service gives too; mocco_notifications_discord_channels_search lists what the bot sees.
          throw new DiscordChannelNotInGuildError(args.discordChannelId);
        }
        const defaultName = `#${discordChannel.name}`;
        return [
          "Connect a Discord channel to this workspace's notifications, as you?",
          `Server: ${guild.guildName}`,
          `Channel: #${discordChannel.name} (${discordChannel.id})`,
          `Name in Mocco: ${args.name ?? defaultName}`,
          'Mocco will post a test message there. Nothing is sent to it until it has rules.',
        ].join('\n');
      },
      apply: async () => {
        const { channel, test } = await notifications.createChannel(workspaceId, userId, {
          guildId: guild.id,
          channelId: args.discordChannelId,
          ...(args.name !== undefined && { name: args.name }),
        });
        return asJson({ changed: true, channel: channelSummary(channel), test: testSummary(test) });
      },
    });
  } catch (error) {
    return changeRefusal(error);
  }
}

export async function reenableChannel(
  deps: NotificationWriteToolDeps,
  args: ReenableArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openChange(deps, ctx, args.workspaceId);
    if ('content' in opened) {
      return opened;
    }
    const { userId, workspaceId, confirmations, notifications } = opened;
    const change = { tool: NotificationWriteTools.reenable, workspaceId, channelId: args.channelId };
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Turn this channel back on',
      ask: async () => {
        const channel = await channelIn(notifications, workspaceId, args.channelId);
        return [
          'Turn this notification channel back on, as you?',
          `Channel: ${channel.name} (${channel.id})`,
          `Now: ${channel.status}`,
          ...(channel.disabledReason === null ? [] : [`Why it is off: ${channel.disabledReason}`]),
          'Mocco checks the bot can still reach it and posts a test message; if it cannot, the channel stays off.',
        ].join('\n');
      },
      apply: async () => {
        const { channel, test } = await notifications.reenableChannel(workspaceId, userId, args.channelId);
        return asJson({ changed: true, channel: channelSummary(channel), test: testSummary(test) });
      },
    });
  } catch (error) {
    return changeRefusal(error);
  }
}

export async function addRule(
  deps: NotificationWriteToolDeps,
  args: AddRuleArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openChange(deps, ctx, args.workspaceId);
    if ('content' in opened) {
      return opened;
    }
    const { userId, workspaceId, confirmations, notifications } = opened;
    const filter = args.filter ?? {};
    const sourceId = args.sourceId ?? null;
    const change = {
      tool: NotificationWriteTools.addRule,
      workspaceId,
      channelId: args.channelId,
      eventType: args.eventType,
      sourceId,
      filter,
    };
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Add this rule',
      ask: async () => {
        const channel = await channelIn(notifications, workspaceId, args.channelId);
        return [
          'Add a notification rule, as you?',
          `Send: ${args.eventType} events`,
          `From source: ${sourceId ?? 'any'}`,
          `Only when: ${describeFilter(filter)}`,
          `To channel: ${channel.name} (${channel.id})`,
        ].join('\n');
      },
      apply: async () => {
        const rule = await notifications.addRule(workspaceId, userId, args.channelId, {
          eventType: args.eventType,
          sourceId,
          filter,
        });
        return asJson({ changed: true, rule: ruleSummary(rule) });
      },
    });
  } catch (error) {
    return changeRefusal(error);
  }
}

/** The rule and its channel, found inside the workspace only. */
async function ruleIn(notifications: Notifications, workspaceId: string, ruleId: string) {
  const channels = await notifications.listChannels(workspaceId);
  const listed = await Promise.all(
    channels.map(async channel => await notifications.listRules(workspaceId, channel.id)),
  );
  const rule = listed.flat().find(each => each.id === ruleId);
  const channel = channels.find(each => each.id === rule?.channelId);
  if (rule === undefined || channel === undefined) {
    throw new NotificationRuleNotFoundError(ruleId);
  }
  return { rule, channel };
}

export async function removeRule(
  deps: NotificationWriteToolDeps,
  args: RemoveRuleArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openChange(deps, ctx, args.workspaceId);
    if ('content' in opened) {
      return opened;
    }
    const { userId, workspaceId, confirmations, notifications } = opened;
    const change = { tool: NotificationWriteTools.removeRule, workspaceId, ruleId: args.ruleId };
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Remove this rule',
      ask: async () => {
        const { rule, channel } = await ruleIn(notifications, workspaceId, args.ruleId);
        return [
          'Remove this notification rule, as you?',
          `Stops sending: ${rule.eventType} events`,
          `From source: ${rule.sourceId ?? 'any'}`,
          `Only when: ${describeFilter(rule.filter)}`,
          `To channel: ${channel.name} (${channel.id})`,
        ].join('\n');
      },
      apply: async () => {
        await notifications.removeRule(workspaceId, userId, args.ruleId);
        return asJson({ changed: true, removedRuleId: args.ruleId });
      },
    });
  } catch (error) {
    return changeRefusal(error);
  }
}

export async function applyPreset(
  deps: NotificationWriteToolDeps,
  args: ApplyPresetArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openChange(deps, ctx, args.workspaceId);
    if ('content' in opened) {
      return opened;
    }
    const { userId, workspaceId, confirmations, notifications } = opened;
    // Mocco's own events have no source, so the service ignores one for that preset; the
    // confirmation says what will really be stored.
    const sourceId = args.preset === RulePresets.mocco ? null : (args.sourceId ?? null);
    const change = {
      tool: NotificationWriteTools.applyPreset,
      workspaceId,
      channelId: args.channelId,
      preset: args.preset,
      sourceId,
    };
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Add these rules',
      ask: async () => {
        const channel = await channelIn(notifications, workspaceId, args.channelId);
        return [
          `Add the ${args.preset} preset's rules to a notification channel, as you?`,
          `To channel: ${channel.name} (${channel.id})`,
          `From source: ${sourceId ?? 'any'}`,
          'Rules (any the channel already has are skipped):',
          ...presetLines(args.preset),
        ].join('\n');
      },
      apply: async () => {
        const added = await notifications.applyDefaultRules(workspaceId, userId, args.channelId, args.preset, sourceId);
        return asJson({ changed: added.length > 0, added: added.map(rule => ruleSummary(rule)) });
      },
    });
  } catch (error) {
    return changeRefusal(error);
  }
}

const CHANGE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, idempotentHint: false } as const;
const SCOPE_CHALLENGE = requireApprovalsWrite(
  'Changing notification settings needs your permission for this app to make changes as you',
);
const CONFIRMED =
  'The person is asked to confirm in their client first. Only works where the workspace allows agents to make changes, and only for an owner or admin.';

export function registerNotificationWriteTools(server: McpServer, deps: NotificationWriteToolDeps): void {
  server.registerTool(
    NotificationWriteTools.discordChannels,
    {
      title: 'Find Discord channels to connect',
      description:
        "The text channels of the workspace's Discord server, as the Mocco bot sees them now, and which are already connected. Owners and admins only (it spends the shared bot's Discord calls). Read-only.",
      inputSchema: discordChannelsInput,
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => {
      try {
        return asJson(await searchDiscordChannels(deps, args, userIdOf(ctx)));
      } catch (error) {
        return changeRefusal(error);
      }
    },
  );

  server.registerTool(
    NotificationWriteTools.connect,
    {
      title: 'Connect a Discord channel',
      description: `Connect a Discord channel of the workspace's server as a notification channel, as the signed-in person; Mocco posts a test message there. ${CONFIRMED}`,
      inputSchema: connectInput,
      annotations: CHANGE_ANNOTATIONS,
      scopeChallenge: SCOPE_CHALLENGE,
    },
    async (args, ctx) => await connectChannel(deps, args, ctx),
  );

  server.registerTool(
    NotificationWriteTools.reenable,
    {
      title: 'Turn a notification channel back on',
      description: `Turn a disabled notification channel back on, once the bot can reach it again, as the signed-in person. ${CONFIRMED}`,
      inputSchema: reenableInput,
      annotations: CHANGE_ANNOTATIONS,
      scopeChallenge: SCOPE_CHALLENGE,
    },
    async (args, ctx) => await reenableChannel(deps, args, ctx),
  );

  server.registerTool(
    NotificationWriteTools.addRule,
    {
      title: 'Add a notification rule',
      description: `Send an event type (optionally from one source, and only when its facts match a filter) to a notification channel, as the signed-in person. ${CONFIRMED}`,
      inputSchema: ruleToAddInput,
      annotations: CHANGE_ANNOTATIONS,
      scopeChallenge: SCOPE_CHALLENGE,
    },
    async (args, ctx) => await addRule(deps, args, ctx),
  );

  server.registerTool(
    NotificationWriteTools.removeRule,
    {
      title: 'Remove a notification rule',
      description: `Remove a notification rule, so its events stop going to its channel, as the signed-in person. ${CONFIRMED}`,
      inputSchema: ruleToRemoveInput,
      annotations: { ...CHANGE_ANNOTATIONS, destructiveHint: true },
      scopeChallenge: SCOPE_CHALLENGE,
    },
    async (args, ctx) => await removeRule(deps, args, ctx),
  );

  server.registerTool(
    NotificationWriteTools.applyPreset,
    {
      title: 'Add a preset of notification rules',
      description: `Add a ready set of rules (mocco, sentry, vercel or github) to a notification channel, skipping any it already has, as the signed-in person. ${CONFIRMED}`,
      inputSchema: applyPresetInput,
      annotations: { ...CHANGE_ANNOTATIONS, idempotentHint: true },
      scopeChallenge: SCOPE_CHALLENGE,
    },
    async (args, ctx) => await applyPreset(deps, args, ctx),
  );
}
