import { isDomainEventType } from '@mocco/common/events';
import { inboundEventTypeSchema } from '@mocco/common/inbound';
import { ChannelKinds, DELIVERY_LIST_MAX, Severities } from '@mocco/common/notification';
import { RulePresets, rulePresetRules } from '@mocco/common/notification-presets';

import { DeliveryPolicy } from '@backend/domain/notification/constants';
import {
  DiscordChannelNotInGuildError,
  DiscordGuildNotFoundError,
  DiscordNotConfiguredError,
  DiscordReinstallRequiredError,
  DiscordRequestFailedError,
  NotificationChannelExistsError,
  NotificationChannelNotFoundError,
  NotificationRuleExistsError,
  NotificationRuleNotFoundError,
  UnknownRuleEventTypeError,
} from '@backend/domain/notification/errors';
import { DiscordResultKinds } from '@backend/domain/notification/senders/discord';
import {
  DISCORD_GLOBAL_BUCKET,
  DiscordJsonErrorCodes,
  discordChannelBucket,
  discordGuildBucket,
} from '@backend/domain/notification/senders/discord-constants';
import { MOCCO_FOOTER } from '@backend/domain/notification/templates';
import { UniqueConstraintError } from '@backend/infra/db/errors';

import type { ChannelRepo, ChannelRow } from '@backend/domain/notification/repos/channel.repo';
import type { DeliveryRepo } from '@backend/domain/notification/repos/delivery.repo';
import type { DiscordGuildRepo, DiscordGuildRow } from '@backend/domain/notification/repos/discord-guild.repo';
import type { DiscordRateLimitRepo } from '@backend/domain/notification/repos/discord-rate-limit.repo';
import type { RuleRepo, RuleRow } from '@backend/domain/notification/repos/rule.repo';
import type {
  DiscordApi,
  DiscordFailure,
  DiscordSendResult,
  DiscordTextChannel,
} from '@backend/domain/notification/senders/discord';
import type { ChannelTestResult, DeliveryStatus, NeutralMessage, RuleFilter } from '@mocco/common/notification';
import type { RulePreset } from '@mocco/common/notification-presets';

/** The Discord calls channel management makes with the Mocco bot. */
export type DiscordChannelApi = Pick<DiscordApi, 'listTextChannels' | 'sendMessage' | 'getBotMember'>;

export interface ChannelServiceDeps {
  guilds: DiscordGuildRepo;
  channels: ChannelRepo;
  rules: RuleRepo;
  deliveries: DeliveryRepo;
  rateLimits: DiscordRateLimitRepo;
  /** Undefined without DISCORD_BOT_TOKEN: reads still work, Discord calls throw. */
  discord: DiscordChannelApi | undefined;
  /** Whether the bot install routes are configured (the Discord OAuth pair and the bot
   * token); false by default, and the install route answers 503. */
  installAvailable?: boolean;
  now: () => Date;
}

/** Posted when a channel is created, so a missing permission shows up at setup. */
export const CHANNEL_TEST_MESSAGE: NeutralMessage = {
  title: 'Mocco is connected',
  description: "Notifications for this workspace will be posted in this channel. There's nothing else to do here.",
  severity: Severities.info,
  fields: [],
  footer: MOCCO_FOOTER,
};

const RATE_LIMITED_REASON = 'Discord is rate limiting the bot; try again in a moment';

const DEFAULT_DELIVERY_LIST = 50;

/**
 * Slack between our clock (`installed_at`) and Discord's (`joined_at`). The bot joins
 * just before our callback records the install, so a join later than this after the
 * install means the bot was re-added since.
 */
export const INSTALL_CLOCK_SKEW_MS = 2 * 60 * 1000;

/** Answers of Discord that mean the bot is not in the guild (any more). */
const BOT_ABSENT_CODES: ReadonlySet<number> = new Set([
  DiscordJsonErrorCodes.UnknownMember,
  DiscordJsonErrorCodes.UnknownGuild,
  DiscordJsonErrorCodes.MissingAccess,
]);

/**
 * Notification channels, their rules and their deliveries, per workspace (relay design
 * §6–§9). Every method takes the workspace the router proved membership of and never
 * reaches another workspace's rows. Discord channels are bound only after the bot lists
 * them in a guild installed for this workspace: the bot is shared by every tenant, so
 * a bare channel id from the client would let one workspace post into another's server.
 */
export class ChannelService {
  constructor(private readonly deps: ChannelServiceDeps) {}

  private requireDiscord(): DiscordChannelApi {
    if (this.deps.discord === undefined) {
      throw new DiscordNotConfiguredError();
    }
    return this.deps.discord;
  }

  private async requireGuild(workspaceId: string, guildId: string): Promise<DiscordGuildRow> {
    const guild = await this.deps.guilds.findById(workspaceId, guildId);
    if (guild === undefined) {
      throw new DiscordGuildNotFoundError(guildId);
    }
    return guild;
  }

  private async requireChannel(workspaceId: string, channelId: string): Promise<ChannelRow> {
    const channel = await this.deps.channels.findById(workspaceId, channelId);
    if (channel === undefined) {
      throw new NotificationChannelNotFoundError(channelId);
    }
    return channel;
  }

  /** Guild routes pace on `guild:<id>` (and the global bucket); a 429 blocks it. */
  private async assertGuildRouteOpen(guild: DiscordGuildRow): Promise<void> {
    const blocked = await this.deps.rateLimits.blockedUntil(
      [discordGuildBucket(guild.guildId), DISCORD_GLOBAL_BUCKET],
      this.deps.now(),
    );
    if (blocked !== undefined) {
      throw new DiscordRequestFailedError(RATE_LIMITED_REASON);
    }
  }

  private async failedGuildCall(guild: DiscordGuildRow, result: DiscordFailure): Promise<never> {
    if (result.kind === DiscordResultKinds.rate_limited) {
      await this.deps.rateLimits.block(result.bucketKey ?? discordGuildBucket(guild.guildId), result.retryAt);
      throw new DiscordRequestFailedError(RATE_LIMITED_REASON);
    }
    throw new DiscordRequestFailedError(result.reason);
  }

  private async textChannels(guild: DiscordGuildRow): Promise<DiscordTextChannel[]> {
    await this.assertGuildRouteOpen(guild);
    const result = await this.requireDiscord().listTextChannels(guild.guildId);
    if (result.kind === DiscordResultKinds.listed) {
      return result.channels;
    }
    return await this.failedGuildCall(guild, result);
  }

  /**
   * Prove the install is still this workspace's: the bot is in the guild and joined it
   * no later than this workspace installed it. Otherwise the row is stale (the bot left,
   * or was re-added since, possibly by another workspace): it is deleted, with its
   * channels, and the user must connect Discord again.
   */
  private async assertCurrentInstall(guild: DiscordGuildRow): Promise<void> {
    await this.assertGuildRouteOpen(guild);
    const result = await this.requireDiscord().getBotMember(guild.guildId);
    if (result.kind === DiscordResultKinds.member) {
      const joinedAt = result.joinedAt?.getTime();
      if (joinedAt === undefined || joinedAt <= guild.installedAt.getTime() + INSTALL_CLOCK_SKEW_MS) {
        return;
      }
    } else if (result.kind !== DiscordResultKinds.permanent || !BOT_ABSENT_CODES.has(result.code ?? 0)) {
      await this.failedGuildCall(guild, result);
    }
    await this.deps.guilds.delete(guild.workspaceId, guild.id);
    throw new DiscordReinstallRequiredError(guild.guildName);
  }

  /** The guild channel `channelId` as the bot lists it now, after proving the install is current. */
  private async currentGuildChannel(guild: DiscordGuildRow, channelId: string): Promise<DiscordTextChannel> {
    await this.assertCurrentInstall(guild);
    const textChannels = await this.textChannels(guild);
    const discordChannel = textChannels.find(candidate => candidate.id === channelId);
    if (discordChannel === undefined) {
      throw new DiscordChannelNotInGuildError(channelId);
    }
    return discordChannel;
  }

  /** Send the test message, recording what Discord tells us about the channel. */
  private async sendTest(channel: ChannelRow): Promise<{ channel: ChannelRow; test: ChannelTestResult }> {
    const now = this.deps.now();
    const blocked = await this.deps.rateLimits.blockedUntil(
      [discordChannelBucket(channel.externalId), DISCORD_GLOBAL_BUCKET],
      now,
    );
    if (blocked !== undefined) {
      return { channel, test: { sent: false, reason: RATE_LIMITED_REASON, channelDisabled: false } };
    }
    const result: DiscordSendResult = await this.requireDiscord().sendMessage(channel.externalId, CHANNEL_TEST_MESSAGE);
    switch (result.kind) {
      case DiscordResultKinds.sent: {
        if (result.bucket?.blockedUntil !== undefined) {
          await this.deps.rateLimits.block(result.bucket.key, result.bucket.blockedUntil);
        }
        return { channel, test: { sent: true, reason: null, channelDisabled: false } };
      }
      case DiscordResultKinds.rate_limited: {
        await this.deps.rateLimits.block(result.bucketKey ?? discordChannelBucket(channel.externalId), result.retryAt);
        return { channel, test: { sent: false, reason: RATE_LIMITED_REASON, channelDisabled: false } };
      }
      case DiscordResultKinds.permanent: {
        if (result.disableChannel) {
          const disabled = await this.deps.channels.disable(channel.workspaceId, channel.id, result.reason);
          return {
            channel: disabled ?? channel,
            test: { sent: false, reason: result.reason, channelDisabled: true },
          };
        }
        if (result.disableSender) {
          const until = new Date(now.getTime() + DeliveryPolicy.senderPauseMs);
          console.error(`[notification] DISCORD SENDER PAUSED until ${until.toISOString()}: ${result.reason}`);
          await this.deps.rateLimits.block(DISCORD_GLOBAL_BUCKET, until);
        }
        return { channel, test: { sent: false, reason: result.reason, channelDisabled: false } };
      }
      case DiscordResultKinds.transient: {
        return { channel, test: { sent: false, reason: result.reason, channelDisabled: false } };
      }
      default: {
        const unexpected: never = result;
        throw new Error(`unexpected Discord result ${JSON.stringify(unexpected)}`);
      }
    }
  }

  /** What this deployment can do with Discord, so the UI can explain a missing setup. */
  discordSetup(): { installAvailable: boolean; botConfigured: boolean } {
    return { installAvailable: this.deps.installAvailable ?? false, botConfigured: this.deps.discord !== undefined };
  }

  /** Discord servers the bot is installed in for the workspace. */
  async listGuilds(workspaceId: string): Promise<DiscordGuildRow[]> {
    return await this.deps.guilds.findByWorkspace(workspaceId);
  }

  /** The text and announcement channels of an installed guild, as the bot sees them. */
  async listGuildChannels(workspaceId: string, guildId: string): Promise<DiscordTextChannel[]> {
    return await this.textChannels(await this.requireGuild(workspaceId, guildId));
  }

  async listChannels(workspaceId: string): Promise<ChannelRow[]> {
    return await this.deps.channels.findByWorkspace(workspaceId);
  }

  /**
   * Bind a Discord channel of an installed guild and post the test message. The
   * channel is stored even when the test fails, so the user sees the reason next to
   * it; a channel the bot cannot reach is stored disabled.
   */
  async createChannel(
    workspaceId: string,
    input: { guildId: string; channelId: string; name?: string },
  ): Promise<{ channel: ChannelRow; test: ChannelTestResult }> {
    const guild = await this.requireGuild(workspaceId, input.guildId);
    const discordChannel = await this.currentGuildChannel(guild, input.channelId);
    let channel: ChannelRow;
    try {
      channel = await this.deps.channels.insert({
        workspaceId,
        kind: ChannelKinds.discord,
        name: input.name ?? `#${discordChannel.name}`,
        config: { guildId: guild.guildId, channelId: discordChannel.id, channelName: discordChannel.name },
        externalId: discordChannel.id,
        guildId: guild.id,
      });
    } catch (error) {
      if (error instanceof UniqueConstraintError) {
        throw new NotificationChannelExistsError(input.channelId, { cause: error });
      }
      throw error;
    }
    return await this.sendTest(channel);
  }

  /** Delete a channel and its rules; its delivery history stays (without the channel). */
  async deleteChannel(workspaceId: string, channelId: string): Promise<void> {
    if (!(await this.deps.channels.delete(workspaceId, channelId))) {
      throw new NotificationChannelNotFoundError(channelId);
    }
  }

  /**
   * Deliver to a disabled channel again, after the customer fixed the bot's access. The
   * same checks as binding run again (the install is current, the bot still lists the
   * channel), then the test message: a channel the bot still cannot reach ends disabled
   * again, with the new reason.
   */
  async reenableChannel(
    workspaceId: string,
    channelId: string,
  ): Promise<{ channel: ChannelRow; test: ChannelTestResult }> {
    const existing = await this.requireChannel(workspaceId, channelId);
    if (existing.guildId === null) {
      throw new NotificationChannelNotFoundError(channelId);
    }
    const guild = await this.requireGuild(workspaceId, existing.guildId);
    await this.currentGuildChannel(guild, existing.externalId);
    const channel = await this.deps.channels.enable(workspaceId, channelId);
    if (channel === undefined) {
      throw new NotificationChannelNotFoundError(channelId);
    }
    return await this.sendTest(channel);
  }

  async listRules(workspaceId: string, channelId: string): Promise<RuleRow[]> {
    await this.requireChannel(workspaceId, channelId);
    return await this.deps.rules.findByChannel(workspaceId, channelId);
  }

  /** Add a rule. An exact type must be one Mocco publishes; a `prefix.*` may name future types. */
  async addRule(
    workspaceId: string,
    channelId: string,
    input: { eventType: string; sourceId: string | null; filter?: RuleFilter },
  ): Promise<RuleRow> {
    await this.requireChannel(workspaceId, channelId);
    const isWildcard = input.eventType.endsWith('.*');
    if (
      !isWildcard &&
      !isDomainEventType(input.eventType) &&
      !inboundEventTypeSchema.safeParse(input.eventType).success
    ) {
      throw new UnknownRuleEventTypeError(input.eventType);
    }
    const [rule] = await this.deps.rules.insertMany([
      {
        workspaceId,
        channelId,
        eventType: input.eventType,
        sourceId: input.sourceId,
        filter: input.filter ?? {},
      },
    ]);
    if (rule === undefined) {
      throw new NotificationRuleExistsError(input.eventType);
    }
    return rule;
  }

  async removeRule(workspaceId: string, ruleId: string): Promise<void> {
    if (!(await this.deps.rules.delete(workspaceId, ruleId))) {
      throw new NotificationRuleNotFoundError(ruleId);
    }
  }

  /**
   * Add a preset's rules to a channel (relay design §7); rules it already has are
   * skipped, so applying a preset twice is a no-op. `sourceId` binds a source preset
   * to one inbound source; Mocco's own events have no source, so the mocco preset
   * ignores it. Returns the rules added.
   */
  async applyDefaultRules(
    workspaceId: string,
    channelId: string,
    preset: RulePreset,
    sourceId?: string | null,
  ): Promise<RuleRow[]> {
    await this.requireChannel(workspaceId, channelId);
    const source = preset === RulePresets.mocco ? null : (sourceId ?? null);
    return await this.deps.rules.insertMany(
      rulePresetRules[preset].map(rule => ({
        workspaceId,
        channelId,
        eventType: rule.eventType,
        sourceId: source,
        filter: rule.filter,
      })),
    );
  }

  /** Recent deliveries of the workspace, newest first. */
  async listDeliveries(
    workspaceId: string,
    options: { channelId?: string; status?: DeliveryStatus; limit?: number } = {},
  ) {
    return await this.deps.deliveries.findRecent(workspaceId, {
      ...(options.channelId !== undefined && { channelId: options.channelId }),
      ...(options.status !== undefined && { status: options.status }),
      limit: Math.min(options.limit ?? DEFAULT_DELIVERY_LIST, DELIVERY_LIST_MAX),
    });
  }
}
