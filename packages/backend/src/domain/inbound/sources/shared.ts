import { createHmac, timingSafeEqual } from 'node:crypto';

import { NeutralMessageLimits } from '@mocco/common/notification';

import type { Facts, InboundEventType } from '@mocco/common/inbound';
import type { NeutralMessage, NeutralMessageActor, Severity } from '@mocco/common/notification';

// Shared plumbing for the pure inbound source adapters (sentry.ts, vercel.ts,
// github.ts): signature checks, safe JSON, text helpers, and NeutralMessage
// assembly with the size limits applied. No I/O, no vendor SDK.

export const ParsedInboundKinds = { event: 'event', ignored: 'ignored' } as const;

/** What an adapter makes of one delivery: a domain event, or the reason it produces none. */
export type ParsedInbound =
  | { kind: typeof ParsedInboundKinds.event; type: InboundEventType; facts: Facts; message: NeutralMessage }
  | { kind: typeof ParsedInboundKinds.ignored; reason: string };

export function ignored(reason: string): ParsedInbound {
  return { kind: ParsedInboundKinds.ignored, reason };
}

export function mapped(type: InboundEventType, facts: Facts, message: NeutralMessage): ParsedInbound {
  return { kind: ParsedInboundKinds.event, type, facts, message };
}

export const IgnoredReasons = {
  malformedJson: 'malformed JSON body',
} as const;

export const HmacAlgorithms = { sha1: 'sha1', sha256: 'sha256' } as const;
export type HmacAlgorithm = (typeof HmacAlgorithms)[keyof typeof HmacAlgorithms];

const HEX = /^[\da-f]+$/iu;

/**
 * Constant-time check that `providedHex` is the HMAC of `rawBody` under
 * `secret`. Hex case is ignored. An empty secret or signature is always
 * rejected (a source cannot exist without a secret, so an empty one is a bug,
 * never a valid configuration). `timingSafeEqual` throws on buffers of
 * different lengths, so the length is compared first; the length of a digest
 * is public.
 */
export function isValidHmacHex(
  algorithm: HmacAlgorithm,
  secret: string,
  rawBody: string,
  providedHex: string,
): boolean {
  if (secret === '' || !HEX.test(providedHex)) {
    return false;
  }
  const expected = createHmac(algorithm, secret).update(rawBody).digest();
  const provided = Buffer.from(providedHex, 'hex');
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/** The parsed body, or undefined when it is not JSON. Never throws. */
export function parseJson(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    return undefined;
  }
}

// String helpers. sonarjs/null-dereference reports every member access on a
// `string`-typed identifier as a possible null dereference (it ignores the
// TypeScript type); every value here is a non-nullable `string`, so the rule
// is off for this block only.
/* eslint-disable sonarjs/null-dereference */

/** A trimmed, non-empty header value, or undefined. */
export function headerValue(headers: Headers, name: string): string | undefined {
  const value = headers.get(name)?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/** `text` without `prefix`, or undefined when it does not start with it. */
export function stripPrefix(text: string, prefix: string): string | undefined {
  return text.startsWith(prefix) ? text.slice(prefix.length) : undefined;
}

/** An `https://` URL for a bare host such as `app.vercel.app`; absolute URLs pass through. */
export function withHttps(url: string): string {
  return /^https?:\/\//iu.test(url) ? url : `https://${url}`;
}

/** First line of a (commit) message. */
export function firstLine(text: string): string {
  return text.split('\n', 1)[0] ?? '';
}

/** `text` on one line: newlines become spaces. */
export function singleLine(text: string): string {
  return text.replaceAll('\n', ' ');
}

const ELLIPSIS = '…';
const HIGH_SURROGATE = /[\uD800-\uDBFF]$/u;

/**
 * `text` cut to at most `max` UTF-16 units (the unit zod's `.max` counts),
 * ending in an ellipsis when cut. A surrogate pair is never split.
 */
export function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  const cut = text.slice(0, max - ELLIPSIS.length);
  return `${HIGH_SURROGATE.test(cut) ? cut.slice(0, -1) : cut}${ELLIPSIS}`;
}

/* eslint-enable sonarjs/null-dereference */

function isHttpUrl(value: string): boolean {
  return URL.canParse(value) && ['http:', 'https:'].includes(new URL(value).protocol);
}

export interface MessageDraft {
  title: string;
  url: string | undefined;
  description?: string;
  severity: Severity;
  fields: { name: string; value: string; inline?: boolean }[];
  actor?: { name: string; url?: string; avatarUrl?: string };
  footer: string;
}

/**
 * A NeutralMessage from loosely-typed parts: every text is truncated to its
 * limit, extra fields are dropped, empty values and non-http links are left
 * out, so the result always satisfies `neutralMessageSchema`.
 */
export function buildMessage(draft: MessageDraft): NeutralMessage {
  const message: NeutralMessage = {
    title: truncate(draft.title, NeutralMessageLimits.title),
    severity: draft.severity,
    fields: draft.fields
      .filter(field => field.value !== '')
      .slice(0, NeutralMessageLimits.fields)
      .map(field => ({
        ...field,
        name: truncate(field.name, NeutralMessageLimits.fieldName),
        value: truncate(field.value, NeutralMessageLimits.fieldValue),
      })),
    footer: truncate(draft.footer, NeutralMessageLimits.footer),
  };
  if (draft.url !== undefined && isHttpUrl(draft.url)) {
    message.url = draft.url;
  }
  if (draft.description !== undefined && draft.description !== '') {
    message.description = truncate(draft.description, NeutralMessageLimits.description);
  }
  if (draft.actor !== undefined && draft.actor.name !== '') {
    const actor: NeutralMessageActor = { name: draft.actor.name };
    if (draft.actor.url !== undefined && isHttpUrl(draft.actor.url)) {
      actor.url = draft.actor.url;
    }
    if (draft.actor.avatarUrl !== undefined && isHttpUrl(draft.actor.avatarUrl)) {
      actor.avatarUrl = draft.actor.avatarUrl;
    }
    message.actor = actor;
  }
  return message;
}
