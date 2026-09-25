import { neutralMessageLength } from '@mocco/common/notification';
import { z } from 'zod';

import {
  CHANNEL_DISABLING_CODES,
  DISCORD_API_BASE,
  DISCORD_DEFAULT_TIMEOUT_MS,
  DISCORD_FALLBACK_RETRY_AFTER_SECONDS,
  DISCORD_GLOBAL_BUCKET,
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

const REASON_MAX = 300;
const ELLIPSIS = '…';
const HIGH_SURROGATE_MIN = 0xd8_00;
const HIGH_SURROGATE_MAX = 0xdb_ff;

const errorBodySchema = z.object({
  code: z.number().int().optional(),
  message: z.string().optional(),
});

const rateLimitBodySchema = z.object({
  retry_after: z.number().nonnegative().optional(),
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

/**
 * The Discord embed for `message`. The severity emoji prefixes the title; the
 * prefix is charged to the title so the embed stays inside Discord's title and
 * 6000-character caps that `neutralMessageSchema` already enforces.
 */
export function renderEmbed(message: NeutralMessage, timestamp: Date) {
  const style = DiscordSeverityStyles[message.severity];
  const prefix = `${style.emoji} `;
  const overflow = Math.max(0, neutralMessageLength(message) + prefix.length - DiscordEmbedLimits.total);
  const titleBudget = DiscordEmbedLimits.title - prefix.length - overflow;
  return {
    title: prefix + truncate(message.title, titleBudget),
    url: message.url,
    description: message.description,
    color: style.color,
    timestamp: timestamp.toISOString(),
    author: message.actor && {
      name: message.actor.name,
      url: message.actor.url,
      icon_url: message.actor.avatarUrl,
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
 * `fetchImpl(url, init)` with a timeout covering the headers and the body. Resolves
 * to a transient failure on timeout or network error instead of rejecting. The
 * Discord OAuth exchange reuses it, so every Discord request goes through here.
 */
export async function timedFetch(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<TimedFetchOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    const text = await response.text();
    clearTimeout(timer);
    return { kind: 'response', response, text };
  } catch (error) {
    clearTimeout(timer);
    if (controller.signal.aborted) {
      return { kind: DiscordResultKinds.transient, reason: `Discord did not answer within ${timeoutMs} ms` };
    }
    // Only the error's class name: a fetch error message may echo request details.
    const name = error instanceof Error ? error.name : 'unknown error';
    return { kind: DiscordResultKinds.transient, reason: `network error reaching Discord (${name})` };
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

  /** The bucket of a 2xx response (none without rate limit headers); `blockedUntil` once remaining hits 0. */
  private bucket(response: Response, key: string): DiscordBucket | undefined {
    const remaining = response.headers.get(DiscordRateLimitHeaders.Remaining);
    const resetAfter = secondsHeader(response.headers, DiscordRateLimitHeaders.ResetAfter);
    const isExhausted = remaining !== null && Number(remaining) <= 0 && resetAfter !== undefined;
    const blocked = isExhausted ? { blockedUntil: addSeconds(this.deps.now(), resetAfter) } : {};
    return remaining === null ? undefined : { key, ...blocked };
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
      return this.permanent(reason, code, { disableChannel: false, disableSender: true });
    }
    // A missing canary message is not a broken channel.
    if (code === DiscordJsonErrorCodes.UnknownMessage) {
      return this.permanent(reason, code, DISABLE_NOTHING);
    }
    const shouldDisableChannel =
      status === 403 || status === 404 || (code !== undefined && CHANNEL_DISABLING_CODES.has(code));
    return this.permanent(reason, code, { disableChannel: shouldDisableChannel, disableSender: false });
  }

  private rateLimited(headers: Headers, json: unknown, bucketKey?: string): DiscordRateLimited {
    const parsed = rateLimitBodySchema.safeParse(json);
    const body = parsed.success ? parsed.data : {};
    const scope = headers.get(DiscordRateLimitHeaders.Scope)?.trim().toLowerCase();
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
    return truncate(redact(reason, [this.deps.botToken]).replaceAll('\u{0}', ''), REASON_MAX);
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

  /** Delete a message the bot posted (the stage0 canary cleans up after itself). */
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
