import { createHmac, timingSafeEqual } from 'node:crypto';

import { NeutralMessageLimits, neutralMessageLength } from '@mocco/common/notification';
import { z } from 'zod';

import type { Facts, InboundEventType } from '@mocco/common/inbound';
import type { NeutralMessage, NeutralMessageActor, Severity } from '@mocco/common/notification';

// Shared plumbing for the pure inbound source adapters (sentry.ts, vercel.ts,
// github.ts): byte-level signature checks, body decoding, safe JSON, text
// helpers, and NeutralMessage assembly with the size limits applied. No I/O,
// no vendor SDK.
//
// Everything an adapter returns ends up in a Postgres text/jsonb column, which
// rejects NUL and lone surrogates (both reachable through JSON `\u` escapes).
// So every string in a message, a fact or a reason goes through `sanitize`.

export const ParsedInboundKinds = { event: 'event', ignored: 'ignored' } as const;

/** What an adapter makes of one delivery: a domain event, or the reason it produces none. */
export type ParsedInbound =
  | { kind: typeof ParsedInboundKinds.event; type: InboundEventType; facts: Facts; message: NeutralMessage }
  | { kind: typeof ParsedInboundKinds.ignored; reason: string };

export const IgnoredReasons = {
  malformedJson: 'malformed JSON body',
  /** For callers: `decodeBody` returned undefined. */
  invalidUtf8: 'body is not valid UTF-8',
} as const;

const REASON_MAX = 200;

// String helpers. sonarjs/null-dereference reports every member access on a
// `string`-typed identifier as a possible null dereference (it ignores the
// TypeScript type); every value here is a non-nullable `string`, so the rule
// is off for this block only.
/* eslint-disable sonarjs/null-dereference */

// With the `u` flag a valid surrogate pair is one code point outside this
// class, so only lone surrogates match.
const LONE_SURROGATE = /[\uD800-\uDFFF]/gu;

/**
 * `text` safe to store in Postgres: NUL removed, lone surrogates replaced by
 * U+FFFD (the same result as `String.prototype.toWellFormed`, which the
 * ES2023 lib typings here do not declare).
 */
export function sanitize(text: string): string {
  return text.replaceAll('\u{0}', '').replaceAll(LONE_SURROGATE, '�');
}

/** A trimmed, non-empty header value, or undefined. */
export function headerValue(headers: Headers, name: string): string | undefined {
  const value = headers.get(name)?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/** `value` unless it is null, undefined, empty or blank (the relay's `||` fallbacks). */
export function nonEmpty(value: string | null | undefined): string | undefined {
  return value === null || value === undefined || value.trim() === '' ? undefined : value;
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
 * `text`, sanitized, then cut to at most `max` UTF-16 units (the unit zod's
 * `.max` counts), ending in an ellipsis when cut. A surrogate pair is never split.
 */
export function truncate(text: string, max: number): string {
  const clean = sanitize(text);
  if (clean.length <= max) {
    return clean;
  }
  const cut = clean.slice(0, max - ELLIPSIS.length);
  return `${HIGH_SURROGATE.test(cut) ? cut.slice(0, -1) : cut}${ELLIPSIS}`;
}

const HEX = /^[\da-f]+$/iu;

/**
 * Constant-time check that `providedHex` is the HMAC of the exact `rawBody`
 * bytes under `secret`. Hex case is ignored; anything but exactly the digest's
 * length in hex is rejected. An empty secret is always rejected (a source
 * cannot exist without one, so an empty secret is a bug, never a
 * configuration). The length of a digest is public, so comparing it before
 * `timingSafeEqual` (which throws on unequal lengths) leaks nothing.
 */
export function isValidHmacHex(
  algorithm: HmacAlgorithm,
  secret: string,
  rawBody: Uint8Array,
  providedHex: string,
): boolean {
  const expected = createHmac(algorithm, secret).update(rawBody).digest();
  if (secret === '' || providedHex.length !== expected.length * 2 || !HEX.test(providedHex)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(providedHex, 'hex'), expected);
}

/* eslint-enable sonarjs/null-dereference */

export const HmacAlgorithms = { sha1: 'sha1', sha256: 'sha256' } as const;
export type HmacAlgorithm = (typeof HmacAlgorithms)[keyof typeof HmacAlgorithms];

/**
 * The body as text for `parse` / `deliveryId`: strict UTF-8, a leading BOM
 * stripped. Undefined when the bytes are not valid UTF-8; callers record that
 * as `IgnoredReasons.invalidUtf8`. Signatures are checked on the bytes, never
 * on this text.
 */
export function decodeBody(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** The parsed body, or undefined when it is not JSON. Never throws. */
export function parseJson(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * `record[key]` only when it is an own property, so a payload value such as
 * `__proto__` or `toString` never resolves to an Object.prototype member.
 */
export function ownValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

const SOURCE_EVENT_MAX = 100;
const actionSchema = z.object({ action: z.string() });

/**
 * The vendor's own name for a delivery, for the receipt's `source_event` column
 * (`issue.created`, `push.opened`): `name`, plus `.action` when the body has a
 * string `action`. Sanitized and capped, since it is stored as text.
 */
export function sourceEventLabel(name: string, json: unknown): string {
  const action = actionSchema.safeParse(json);
  return truncate(action.success ? `${name}.${action.data.action}` : name, SOURCE_EVENT_MAX);
}

export function ignored(reason: string): ParsedInbound {
  return { kind: ParsedInboundKinds.ignored, reason: truncate(reason, REASON_MAX) };
}

export function mapped(type: InboundEventType, facts: Facts, message: NeutralMessage): ParsedInbound {
  const clean = Object.fromEntries(
    Object.entries(facts).map(([name, value]) => [name, typeof value === 'string' ? sanitize(value) : value]),
  );
  return { kind: ParsedInboundKinds.event, type, facts: clean, message };
}

function httpUrl(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const clean = sanitize(value);
  return URL.canParse(clean) && ['http:', 'https:'].includes(new URL(clean).protocol) ? clean : undefined;
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
 * Keeps fields in order while the whole message stays within
 * `NeutralMessageLimits.total`. Every other part is already capped, and those
 * caps sum to less than the total, so dropping fields always suffices.
 */
function fitTotal(message: NeutralMessage): NeutralMessage {
  const budget = NeutralMessageLimits.total - neutralMessageLength({ ...message, fields: [] });
  const fields = message.fields.reduce<{ kept: NeutralMessage['fields']; used: number }>(
    (acc, field) => {
      const size = field.name.length + field.value.length;
      return acc.used + size > budget ? acc : { kept: [...acc.kept, field], used: acc.used + size };
    },
    { kept: [], used: 0 },
  );
  return { ...message, fields: fields.kept };
}

/**
 * A NeutralMessage from loosely-typed parts: every text is sanitized and
 * truncated to its limit, extra fields are dropped, empty values and non-http
 * links are left out, and fields are dropped from the end until the total fits,
 * so the result always satisfies `neutralMessageSchema`.
 */
export function buildMessage(draft: MessageDraft): NeutralMessage {
  const message: NeutralMessage = {
    title: truncate(draft.title, NeutralMessageLimits.title),
    severity: draft.severity,
    fields: draft.fields
      .map(field => ({
        ...field,
        name: truncate(field.name, NeutralMessageLimits.fieldName),
        value: truncate(field.value, NeutralMessageLimits.fieldValue),
      }))
      .filter(field => field.value !== '' && field.name !== '')
      .slice(0, NeutralMessageLimits.fields),
    footer: truncate(draft.footer, NeutralMessageLimits.footer),
  };
  const url = httpUrl(draft.url);
  if (url !== undefined) {
    message.url = url;
  }
  const description =
    draft.description === undefined ? '' : truncate(draft.description, NeutralMessageLimits.description);
  if (description !== '') {
    message.description = description;
  }
  const actorName = draft.actor === undefined ? '' : truncate(draft.actor.name, NeutralMessageLimits.actorName);
  if (draft.actor !== undefined && actorName !== '') {
    const actor: NeutralMessageActor = { name: actorName };
    const actorUrl = httpUrl(draft.actor.url);
    if (actorUrl !== undefined) {
      actor.url = actorUrl;
    }
    const avatarUrl = httpUrl(draft.actor.avatarUrl);
    if (avatarUrl !== undefined) {
      actor.avatarUrl = avatarUrl;
    }
    message.actor = actor;
  }
  return fitTotal(message);
}
