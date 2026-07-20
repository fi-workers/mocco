import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { WebhookParseError } from '@backend/domain/integration/github/errors';
import { parseWebhook } from '@backend/domain/integration/github/provider';

// Hand-authored minimal fixtures (no live GitHub deliveries available here) —
// each satisfies the zod schemas in ./webhook-events verbatim.
function readFixture(name: string): string {
  // Synchronous read is intentional: fixture files are tiny, loaded once at
  // module scope (not in a hot path), and this keeps the test setup free of
  // top-level await plumbing.
  // eslint-disable-next-line n/no-sync
  return readFileSync(fileURLToPath(new URL(`../testdata/${name}`, import.meta.url)), 'utf8');
}

const pushFixture = readFixture('push.json');
const installationDeletedFixture = readFixture('installation-deleted.json');

describe('parseWebhook', () => {
  it('parses a push event into commits', () => {
    const result = parseWebhook('push', pushFixture);
    expect(result.kind).toBe('push');
    if (result.kind !== 'push') {
      throw new Error('expected push');
    }
    expect(result.data.commits.length).toBeGreaterThan(0);
  });

  it('parses an installation "deleted" event', () => {
    const result = parseWebhook('installation', installationDeletedFixture);
    expect(result.kind).toBe('installation');
    if (result.kind !== 'installation') {
      throw new Error('expected installation');
    }
    expect(result.data.action).toBe('deleted');
  });

  it('returns { kind: "ignored" } for an event type we do not handle', () => {
    expect(parseWebhook('star', pushFixture)).toEqual({ kind: 'ignored', eventType: 'star' });
  });

  it('returns { kind: "ignored", eventType: "unknown" } when GitHub sent no event header', () => {
    expect(parseWebhook(null, pushFixture)).toEqual({ kind: 'ignored', eventType: 'unknown' });
  });

  it('throws a mapped domain error (never a raw zod issue dump) when the body fails schema validation', () => {
    const invalidPush = JSON.stringify({ not: 'a push event' });
    let thrown: unknown;
    try {
      parseWebhook('push', invalidPush);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WebhookParseError);
    const { message } = thrown as Error;
    expect(message).not.toMatch(/zod/i);
    expect(message).not.toMatch(/invalid_type/i);
    expect(message).not.toMatch(/issues/i);
  });

  it('throws a mapped domain error for malformed JSON (not a raw SyntaxError)', () => {
    expect(() => parseWebhook('push', '{not json')).toThrow(WebhookParseError);
  });
});
