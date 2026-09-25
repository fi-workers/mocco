import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { neutralMessageSchema } from '@mocco/common/notification';
import { expect } from 'vitest';

import type { ParsedInbound } from '@backend/domain/inbound/sources/shared';

/** Raw text of a fixture under `domain/inbound/testdata/`, e.g. `github/push.json`. */
export function readFixture(name: string): string {
  // Synchronous read is intentional: fixtures are tiny and read once per test.
  // eslint-disable-next-line n/no-sync
  return readFileSync(fileURLToPath(new URL(`../testdata/${name}`, import.meta.url)), 'utf8');
}

type Json = Record<string, unknown>;

function setPath(root: Json, path: string, value: unknown): Json {
  // sonarjs/null-dereference false positive: `path` is a non-nullable string.
  // eslint-disable-next-line sonarjs/null-dereference
  const keys = path.split('.');
  const last = keys.pop();
  if (last === undefined) {
    throw new Error('empty patch path');
  }
  const parent = keys.reduce<Json>((node, key) => node[key] as Json, root);
  if (value === undefined) {
    delete parent[last];
  } else {
    parent[last] = value;
  }
  return root;
}

/**
 * A fixture re-serialized with values replaced at dotted paths
 * (`{ 'data.issue.level': 'warning' }`); `undefined` removes the key.
 */
export function patchFixture(name: string, patches: Record<string, unknown>): string {
  const patched = Object.entries(patches).reduce(
    (root, [path, value]) => setPath(root, path, value),
    JSON.parse(readFixture(name)) as Json,
  );
  return JSON.stringify(patched);
}

export function hmacHex(algorithm: 'sha1' | 'sha256', secret: string, rawBody: string | Uint8Array): string {
  return createHmac(algorithm, secret).update(rawBody).digest('hex');
}

/** The UTF-8 bytes of `text`, as a webhook body arrives on the wire. */
export function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

// JSON.stringify escapes NUL as \u0000 and a lone surrogate as \udXXX; either
// in a stored reason, fact or message would make the Postgres text/jsonb write fail.
const POSTGRES_HOSTILE = /\\u0000|\\ud[89a-f][\da-f]{2}/iu;

/** Asserts no NUL and no lone surrogate anywhere in `value`. */
export function expectPostgresSafe(value: unknown): void {
  expect(JSON.stringify(value)).not.toMatch(POSTGRES_HOSTILE);
}

type ParsedEvent = Extract<ParsedInbound, { kind: 'event' }>;

/** Narrows to an event, and checks its message against the shared schema and for Postgres-hostile text. */
export function expectEvent(parsed: ParsedInbound): ParsedEvent {
  if (parsed.kind !== 'event') {
    throw new Error(`expected an event, got ignored: ${parsed.reason}`);
  }
  expect(neutralMessageSchema.parse(parsed.message)).toStrictEqual(parsed.message);
  expectPostgresSafe(parsed);
  return parsed;
}

export function expectIgnored(parsed: ParsedInbound): string {
  if (parsed.kind !== 'ignored') {
    throw new Error(`expected ignored, got event ${parsed.type}`);
  }
  expectPostgresSafe(parsed.reason);
  return parsed.reason;
}
