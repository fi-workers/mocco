import { Severities } from '@mocco/common/notification';

import type { Severity } from '@mocco/common/notification';

// Discord REST facts the sender and the OAuth exchange depend on. Every value
// here comes from Discord's developer docs (linked per group); nothing else in
// the codebase should spell a Discord number or header name.

export const DISCORD_API_BASE = 'https://discord.com/api/v10';

/** https://docs.discord.com/developers/topics/oauth2 (authorization URL). */
export const DISCORD_AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';

/**
 * Discord asks every bot to send `DiscordBot ($url, $versionNumber)`; the URL is the
 * production host (ADR 0006).
 * https://docs.discord.com/developers/reference (User Agent).
 */
export const DISCORD_USER_AGENT = 'DiscordBot (https://www.mocco.club, 1)';

/** Spec §6: a Discord call that has not answered in 5 s is a transient failure. */
export const DISCORD_DEFAULT_TIMEOUT_MS = 5000;

/**
 * Used when a 429 carries neither `retry_after` nor a usable header (for example a
 * Cloudflare ban page). Deliberately long: guessing short would keep hammering.
 */
export const DISCORD_FALLBACK_RETRY_AFTER_SECONDS = 60;

/**
 * A 429 with neither `X-RateLimit-Scope` nor Discord's JSON body comes from
 * Cloudflare, not Discord: the egress IP is banned (after 10,000 invalid requests
 * in 10 minutes), which blocks every send. Wait at least this long before trying
 * again. https://docs.discord.com/developers/topics/rate-limits (invalid request limit).
 */
export const DISCORD_CLOUDFLARE_BAN_RETRY_SECONDS = 15 * 60;

/** Cap on a stored failure reason (Discord's message can be long). */
export const DISCORD_REASON_MAX = 300;

/** https://docs.discord.com/developers/topics/permissions (bitwise permission flags). */
export const DiscordPermissions = {
  ViewChannel: 2 ** 10,
  SendMessages: 2 ** 11,
  EmbedLinks: 2 ** 14,
  ReadMessageHistory: 2 ** 16,
} as const;

/**
 * The permissions the Mocco bot asks for on install (spec §6). The flags are
 * distinct powers of two, so their sum is their bitwise OR (84992).
 */
export const DISCORD_BOT_PERMISSIONS = Object.values(DiscordPermissions).reduce((sum, flag) => sum + flag, 0);

/** Space-separated; a non-bot scope makes Discord return a `code` to exchange. */
export const DISCORD_BOT_SCOPES = 'bot identify';

/**
 * `integration_type` on the authorize URL: install into a server, not a user.
 * https://docs.discord.com/developers/topics/oauth2 (bot authorization flow).
 */
export const DISCORD_GUILD_INSTALL = 0;

/** https://docs.discord.com/developers/topics/opcodes-and-status-codes (JSON error codes). */
export const DiscordJsonErrorCodes = {
  UnknownChannel: 10_003,
  UnknownGuild: 10_004,
  UnknownMessage: 10_008,
  /** Cloudflare is blocking the request (often a bad User-Agent): nothing will get through. */
  CloudflareBlocked: 40_333,
  MissingAccess: 50_001,
  MissingPermissions: 50_013,
  InvalidFormBody: 50_035,
} as const;
export type DiscordJsonErrorCode = (typeof DiscordJsonErrorCodes)[keyof typeof DiscordJsonErrorCodes];

/** The JSON codes that mean the bot can no longer reach the channel: stop sending to it. */
export const CHANNEL_DISABLING_CODES: ReadonlySet<number> = new Set([
  DiscordJsonErrorCodes.UnknownChannel,
  DiscordJsonErrorCodes.UnknownGuild,
  DiscordJsonErrorCodes.MissingAccess,
  DiscordJsonErrorCodes.MissingPermissions,
]);

/** https://docs.discord.com/developers/resources/channel (channel types). */
export const DiscordChannelTypes = {
  GuildText: 0,
  GuildAnnouncement: 5,
} as const;
export type DiscordChannelType = (typeof DiscordChannelTypes)[keyof typeof DiscordChannelTypes];

/** https://docs.discord.com/developers/topics/rate-limits (header format). */
export const DiscordRateLimitHeaders = {
  Remaining: 'X-RateLimit-Remaining',
  Reset: 'X-RateLimit-Reset',
  ResetAfter: 'X-RateLimit-Reset-After',
  Global: 'X-RateLimit-Global',
  Scope: 'X-RateLimit-Scope',
  RetryAfter: 'Retry-After',
} as const;

/**
 * `X-RateLimit-Scope` values on a 429. A `shared` 429 is a per-resource limit
 * other callers exhausted; Discord does not count it as an invalid request.
 */
export const DiscordRateLimitScopes = {
  user: 'user',
  global: 'global',
  shared: 'shared',
} as const;
export type DiscordRateLimitScope = (typeof DiscordRateLimitScopes)[keyof typeof DiscordRateLimitScopes];

/** Bucket keys the relay paces on (spec §6: `channel:<id>` and `global`). */
export const DISCORD_GLOBAL_BUCKET = 'global';
export function discordChannelBucket(channelId: string): string {
  return `channel:${channelId}`;
}

/** Embed presentation per severity: the color bar and the title prefix. */
export const DiscordSeverityStyles: Readonly<Record<Severity, { color: number; emoji: string }>> = {
  [Severities.error]: { color: 0xc2_40_36, emoji: '🔴' },
  [Severities.warning]: { color: 0xe0_a0_3a, emoji: '🟠' },
  [Severities.success]: { color: 0x3b_a5_5d, emoji: '🟢' },
  [Severities.info]: { color: 0x58_65_f2, emoji: '🔵' },
};

/** https://docs.discord.com/developers/resources/message (embed limits). */
export const DiscordEmbedLimits = {
  title: 256,
  total: 6000,
} as const;
