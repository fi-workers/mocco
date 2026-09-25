import { neutralMessageLength } from '@mocco/common/notification';
import { z } from 'zod';

import {
  CHANNEL_DISABLING_CODES,
  DISCORD_API_BASE,
  DISCORD_CLOUDFLARE_BAN_RETRY_SECONDS,
  DISCORD_DEFAULT_TIMEOUT_MS,
  DISCORD_FALLBACK_RETRY_AFTER_SECONDS,
  DISCORD_GLOBAL_BUCKET,
  DISCORD_REASON_MAX,
  DISCORD_USER_AGENT,
  DiscordChannelTypes,
  DiscordEmbedLimits,
  DiscordJsonErrorCodes,
  DiscordRateLimitHeaders,
  DiscordRateLimitScopes,
  DiscordSeverityStyles,
  discordChannelBucket,
} from '@backend/domain/notification/senders/discord-constants';

import type { NeutralMessage } from '@mocco/common/notification';

// The only file that talks to the Discord REST API (plain fetch, v10). It turns
// a NeutralMessage into one embed, and every HTTP outcome into a result value:
// nothing here throws for a Discord answer, a timeout or a network error, so
// the caller (the delivery job) decides retries and channel disabling from data.
//
// Error hygiene: a reason is built from the status, Discord's JSON `code` and
// its `message` only, then redacted, so neither the bot token nor the
// Authorization header can reach a stored reason or a log line.

export const DiscordResultKinds = {
  sent: 'sent',
  deleted: 'deleted',
  listed: 'listed',
  rate_limited: 'rate_limited',
  permanent: 'permanent',
  transient: 'transient',
} as const;

/** Pacing learned from a successful response: the bucket and, when exhausted, until when. */
export interface DiscordBucket {
  key: string;
  blockedUntil?: Date;
}

export interface DiscordRateLimited {
  kind: typeof DiscordResultKinds.rate_limited;
  retryAt: Date;
  /** The bot-wide limit, not a per-route one: pause every send, not just this channel. */
  global: boolean;
  /**
   * `X-RateLimit-Scope: shared`: a per-resource limit others exhausted. Discord does
   * not count it as an invalid request, so it should not count as a failed attempt.
   */
  shared: boolean;
  /** `channel:<id>` or `global`; absent for a per-route limit on a non-channel route. */
  bucketKey?: string;
}

export interface DiscordPermanent {
  kind: typeof DiscordResultKinds.permanent;
  reason: string;
  code?: number;
  /** The bot cannot reach this channel any more (403/404, missing access/permissions). */
  disableChannel: boolean;
  /** The bot token itself is rejected (401): a configuration error for every channel. */
  disableSender: boolean;
}

export interface DiscordTransient {
  kind: typeof DiscordResultKinds.transient;
  reason: string;
  status?: number;
}

export type DiscordFailure = DiscordRateLimited | DiscordPermanent | DiscordTransient;

export interface DiscordSent {
  kind: typeof DiscordResultKinds.sent;
  messageId: string;
  bucket?: DiscordBucket;
}

export interface DiscordDeleted {
  kind: typeof DiscordResultKinds.deleted;
  bucket?: DiscordBucket;
}

export interface DiscordTextChannel {
  id: string;
  name: string;
  type: number;
}

export interface DiscordChannelList {
  kind: typeof DiscordResultKinds.listed;
  channels: DiscordTextChannel[];
}

export type DiscordSendResult = DiscordSent | DiscordFailure;
export type DiscordDeleteResult = DiscordDeleted | DiscordFailure;
export type DiscordChannelListResult = DiscordChannelList | DiscordFailure;

export interface DiscordApiDeps {
  fetch: typeof fetch;
  botToken: string;
  now: () => Date;
  timeoutMs?: number;
}

const ELLIPSIS = '…';
const HIGH_SURROGATE_MIN = 0xd8_00;
const HIGH_SURROGATE_MAX = 0xdb_ff;

const errorBodySchema = z.object({
  code: z.number().int().optional(),
  message: z.string().optional(),
});

/** Discord's own 429 body; a 429 without it (and without a scope header) is Cloudflare's. */
const rateLimitBodySchema = z.object({
  retry_after: z.number().nonnegative(),
  global: z.boolean().optional(),
});

const createdMessageSchema = z.object({ id: z.string().min(1) });

const guildChannelsSchema = z.array(
  z.object({
    id: z.string(),
    type: z.number().int(),
    name: z.string().nullish(),
    position: z.number().int().nullish(),
  }),
);

const TEXT_CHANNEL_TYPES: ReadonlySet<number> = new Set([
  DiscordChannelTypes.GuildText,
  DiscordChannelTypes.GuildAnnouncement,
]);

// String helpers. sonarjs/null-dereference reports every member access on a
// `string`-typed identifier as a possible null dereference (it ignores the
// TypeScript type); every value here is a non-nullable `string`, so the rule
// is off for this block only (same as domain/inbound/sources/shared.ts).
/* eslint-disable sonarjs/null-dereference */

/** `text` cut to `max` UTF-16 units (with an ellipsis), never splitting a surrogate pair. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  const cut = text.slice(0, max - ELLIPSIS.length);
  const last = cut.codePointAt(cut.length - 1) ?? 0;
  const isHalfPair = last >= HIGH_SURROGATE_MIN && last <= HIGH_SURROGATE_MAX;
  return (isHalfPair ? cut.slice(0, -1) : cut) + ELLIPSIS;
}

/** `text` with every occurrence of each non-empty secret replaced. */
export function redact(text: string, secrets: readonly string[]): string {
  return secrets.filter(secret => secret !== '').reduce((out, secret) => out.replaceAll(secret, '[redacted]'), text);
}

/** A non-negative number of seconds from a header, or undefined. */
function secondsHeader(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null || raw.trim() === '') {
    return undefined;
  }
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

/** `value` when it is an absolute http(s) URL; anything else (javascript:, ftp:, …) is dropped. */
function httpUrl(value: string | undefined): string | undefined {
  if (value === undefined || !URL.canParse(value)) {
    return undefined;
  }
  const { protocol } = new URL(value);
  return protocol === 'http:' || protocol === 'https:' ? value : undefined;
}

/**
 * The Discord embed for `message`. The severity emoji prefixes the title. The
 * prefix is charged to the title (256) and to the embed total (6000): when a
 * message already near the total would overflow, the description gives up the
 * difference, and without a description long enough the prefix is dropped
 * (`neutralMessageSchema` guarantees the unprefixed message fits).
 */
export function renderEmbed(message: NeutralMessage, timestamp: Date) {
  const style = DiscordSeverityStyles[message.severity];
  const prefixedTitle = truncate(`${style.emoji} ${message.title}`, DiscordEmbedLimits.title);
  const overflow = neutralMessageLength({ ...message, title: prefixedTitle }) - DiscordEmbedLimits.total;
  const { description } = message;
  const canShortenDescription = overflow > 0 && description !== undefined && description.length > overflow;
  const isPrefixDropped = overflow > 0 && !canShortenDescription;
  return {
    title: isPrefixDropped ? message.title : prefixedTitle,
    url: httpUrl(message.url),
    description: canShortenDescription ? truncate(description, description.length - overflow) : description,
    color: style.color,
    timestamp: timestamp.toISOString(),
    author: message.actor && {
      name: message.actor.name,
      url: httpUrl(message.actor.url),
      icon_url: httpUrl(message.actor.avatarUrl),
    },
    fields: message.fields.map(field => ({ name: field.name, value: field.value, inline: field.inline ?? false })),
    footer: { text: message.footer },
  };
}

/* eslint-enable sonarjs/null-dereference */

export interface TimedResponse {
  kind: 'response';
  response: Response;
  text: string;
}

export type TimedFetchOutcome = TimedResponse | DiscordTransient;

/**
 * `fetchImpl(url, init)` with a timeout covering the headers and the body, combined
 * with the caller's own `init.signal`. Resolves to a transient failure on timeout,
 * cancellation or network error instead of rejecting. The Discord OAuth exchange
 * reuses it, so every Discord request goes through here.
 */
export async function timedFetch(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<TimedFetchOutcome> {
  const timeout = new AbortController();
  const timer = setTimeout(() => {
    timeout.abort();
  }, timeoutMs);
  const callerSignal = init.signal ?? undefined;
  const signal = callerSignal === undefined ? timeout.signal : AbortSignal.any([timeout.signal, callerSignal]);
  try {
    const response = await fetchImpl(url, { ...init, signal });
    const text = await response.text();
    return { kind: 'response', response, text };
  } catch (error) {
    if (timeout.signal.aborted) {
      return { kind: DiscordResultKinds.transient, reason: `Discord did not answer within ${timeoutMs} ms` };
    }
    if (callerSignal?.aborted === true) {
      return { kind: DiscordResultKinds.transient, reason: 'request to Discord was cancelled' };
    }
    // Only the error's class name: a fetch error message may echo request details.
    const name = error instanceof Error ? error.name : 'unknown error';
    return { kind: DiscordResultKinds.transient, reason: `network error reaching Discord (${name})` };
  } finally {
    clearTimeout(timer);
  }
}

/** JSON body of a response, or undefined when it is empty or not JSON. */
export function parseJson(text: string): unknown {
  if (text === '') {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + Math.ceil(seconds * 1000));
}

/** `Discord 403 (code 50001): Missing Access`, with the parts Discord sent. */
function failureReason(status: number, code: number | undefined, message: string | undefined): string {
  const codePart = code === undefined ? '' : ` (code ${code})`;
  const messagePart = message === undefined ? '' : `: ${message}`;
  return `Discord ${status}${codePart}${messagePart}`;
}

interface Disabling {
  disableChannel: boolean;
  disableSender: boolean;
}

const DISABLE_NOTHING: Disabling = { disableChannel: false, disableSender: false };
const SENDER_LEVEL: Disabling = { disableChannel: false, disableSender: true };

export class DiscordApi {
  private readonly timeoutMs: number;

  constructor(private readonly deps: DiscordApiDeps) {
    this.timeoutMs = deps.timeoutMs ?? DISCORD_DEFAULT_TIMEOUT_MS;
  }

  private async request(method: string, path: string, body?: unknown): Promise<TimedFetchOutcome> {
    const headers: Record<string, string> = {
      Authorization: `Bot ${this.deps.botToken}`,
      'User-Agent': DISCORD_USER_AGENT,
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    return await timedFetch(
      this.deps.fetch,
      DISCORD_API_BASE + path,
      { method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
      this.timeoutMs,
    );
  }

  /** When an exhausted bucket resets: `Reset-After` (seconds from now), else `Reset` (epoch seconds). */
  // eslint-disable-next-line sonarjs/function-return-type -- undefined is a legitimate "no information" answer
  private resetTime(headers: Headers): Date | undefined {
    const resetAfter = secondsHeader(headers, DiscordRateLimitHeaders.ResetAfter);
    if (resetAfter !== undefined) {
      return addSeconds(this.deps.now(), resetAfter);
    }
    const resetEpoch = secondsHeader(headers, DiscordRateLimitHeaders.Reset);
    return resetEpoch === undefined ? undefined : new Date(Math.ceil(resetEpoch * 1000));
  }

  /** The bucket of a 2xx response (none without rate limit headers); `blockedUntil` once remaining hits 0. */
  // eslint-disable-next-line sonarjs/function-return-type -- undefined is a legitimate "no information" answer
  private bucket(response: Response, key: string): DiscordBucket | undefined {
    const remaining = response.headers.get(DiscordRateLimitHeaders.Remaining);
    if (remaining === null) {
      return undefined;
    }
    const blockedUntil = Number(remaining) <= 0 ? this.resetTime(response.headers) : undefined;
    return blockedUntil === undefined ? { key } : { key, blockedUntil };
  }

  // eslint-disable-next-line sonarjs/function-return-type -- each branch is one member of the DiscordFailure union
  private failure(response: Response, text: string, bucketKey?: string): DiscordFailure {
    const { status, headers } = response;
    const json = parseJson(text);
    if (status === 429) {
      return this.rateLimited(headers, json, bucketKey);
    }
    const parsed = errorBodySchema.safeParse(json);
    const { code, message } = parsed.success ? parsed.data : {};
    const reason = failureReason(status, code, message);
    if (status >= 500) {
      return { kind: DiscordResultKinds.transient, reason: this.clean(reason), status };
    }
    if (status === 401) {
      return this.permanent(reason, code, SENDER_LEVEL);
    }
    // Only Discord's own "this channel is gone / closed to the bot" codes disable a
    // channel. Other codes (10008 on a canary delete, 50035, 50008) disable nothing.
    if (code !== undefined && CHANNEL_DISABLING_CODES.has(code)) {
      return this.permanent(reason, code, { disableChannel: true, disableSender: false });
    }
    // A 403/404 without a Discord code (or code 0), or Cloudflare's 40333, never got
    // to a channel decision: a bad route, User-Agent or block that hits every tenant.
    // Stop the sender once instead of disabling channels one by one.
    const isUncoded = code === undefined || code === 0;
    const isSenderLevel =
      code === DiscordJsonErrorCodes.CloudflareBlocked || ((status === 403 || status === 404) && isUncoded);
    return this.permanent(reason, code, isSenderLevel ? SENDER_LEVEL : DISABLE_NOTHING);
  }

  private rateLimited(headers: Headers, json: unknown, bucketKey?: string): DiscordRateLimited {
    const parsed = rateLimitBodySchema.safeParse(json);
    const scope = headers.get(DiscordRateLimitHeaders.Scope)?.trim().toLowerCase();
    if (scope === undefined && !parsed.success) {
      // Cloudflare's IP ban, not a Discord limit: it blocks every send from this IP.
      const retryAfter = secondsHeader(headers, DiscordRateLimitHeaders.RetryAfter) ?? 0;
      return {
        kind: DiscordResultKinds.rate_limited,
        retryAt: addSeconds(this.deps.now(), Math.max(retryAfter, DISCORD_CLOUDFLARE_BAN_RETRY_SECONDS)),
        global: true,
        shared: false,
        bucketKey: DISCORD_GLOBAL_BUCKET,
      };
    }
    const body: { retry_after?: number; global?: boolean } = parsed.success ? parsed.data : {};
    const isGlobal =
      body.global === true || headers.has(DiscordRateLimitHeaders.Global) || scope === DiscordRateLimitScopes.global;
    const seconds =
      body.retry_after ??
      secondsHeader(headers, DiscordRateLimitHeaders.RetryAfter) ??
      secondsHeader(headers, DiscordRateLimitHeaders.ResetAfter) ??
      DISCORD_FALLBACK_RETRY_AFTER_SECONDS;
    return {
      kind: DiscordResultKinds.rate_limited,
      retryAt: addSeconds(this.deps.now(), seconds),
      global: isGlobal,
      shared: scope === DiscordRateLimitScopes.shared,
      bucketKey: isGlobal ? DISCORD_GLOBAL_BUCKET : bucketKey,
    };
  }

  private permanent(reason: string, code: number | undefined, disabling: Disabling): DiscordPermanent {
    return {
      kind: DiscordResultKinds.permanent,
      reason: this.clean(reason),
      ...(code !== undefined && { code }),
      ...disabling,
    };
  }

  private clean(reason: string): string {
    // NUL is stripped: reasons land in Postgres text columns, which reject it.
    return truncate(redact(reason, [this.deps.botToken]).replaceAll('\u{0}', ''), DISCORD_REASON_MAX);
  }

  /** Post `message` as one embed. Mentions are never parsed: customer text must not ping @everyone. */
  async sendMessage(channelId: string, message: NeutralMessage): Promise<DiscordSendResult> {
    const bucketKey = discordChannelBucket(channelId);
    const body = { embeds: [renderEmbed(message, this.deps.now())], allowed_mentions: { parse: [] } };
    const outcome = await this.request('POST', `/channels/${encodeURIComponent(channelId)}/messages`, body);
    if (outcome.kind !== 'response') {
      return outcome;
    }
    const { response, text } = outcome;
    if (!response.ok) {
      return this.failure(response, text, bucketKey);
    }
    const created = createdMessageSchema.safeParse(parseJson(text));
    if (!created.success) {
      // The message was most likely posted: retrying would duplicate it.
      return this.permanent(`Discord ${response.status}: unexpected message response`, undefined, DISABLE_NOTHING);
    }
    return { kind: DiscordResultKinds.sent, messageId: created.data.id, bucket: this.bucket(response, bucketKey) };
  }

  /**
   * Delete a message the bot posted (the stage0 canary cleans up after itself).
   * Discord buckets DELETE separately from POST, but both are reported on the same
   * `channel:<id>` bucket: pacing them together is the conservative choice.
   */
  async deleteMessage(channelId: string, messageId: string): Promise<DiscordDeleteResult> {
    const bucketKey = discordChannelBucket(channelId);
    const path = `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`;
    const outcome = await this.request('DELETE', path);
    if (outcome.kind !== 'response') {
      return outcome;
    }
    if (!outcome.response.ok) {
      return this.failure(outcome.response, outcome.text, bucketKey);
    }
    return { kind: DiscordResultKinds.deleted, bucket: this.bucket(outcome.response, bucketKey) };
  }

  /** The guild's text and announcement channels, in Discord's display order. */
  async listTextChannels(guildId: string): Promise<DiscordChannelListResult> {
    const outcome = await this.request('GET', `/guilds/${encodeURIComponent(guildId)}/channels`);
    if (outcome.kind !== 'response') {
      return outcome;
    }
    if (!outcome.response.ok) {
      return this.failure(outcome.response, outcome.text);
    }
    const parsed = guildChannelsSchema.safeParse(parseJson(outcome.text));
    if (!parsed.success) {
      return {
        kind: DiscordResultKinds.transient,
        reason: 'Discord returned an unexpected channel list',
        status: outcome.response.status,
      };
    }
    const channels = parsed.data
      .filter(channel => TEXT_CHANNEL_TYPES.has(channel.type))
      .toSorted((a, b) => (a.position ?? 0) - (b.position ?? 0))
      .map(channel => ({ id: channel.id, name: channel.name ?? '', type: channel.type }));
    return { kind: DiscordResultKinds.listed, channels };
  }
}
