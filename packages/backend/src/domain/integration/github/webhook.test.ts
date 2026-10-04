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
const pullRequestOpenedFixture = readFixture('pull-request-opened.json');

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

  it('parses a pull_request event into its head and base', () => {
    const result = parseWebhook('pull_request', pullRequestOpenedFixture);
    expect(result.kind).toBe('pull_request');
    if (result.kind !== 'pull_request') {
      throw new Error('expected pull_request');
    }
    expect(result.data).toMatchObject({
      action: 'opened',
      installation: { id: 12_345_678 },
      repository: { id: 654_321 },
      pull_request: {
        number: 42,
        head: { sha: '9f8e7d6c5b4a39281706f5e4d3c2b1a098765432' },
        base: { ref: 'main', sha: '1b2c3d4e5f60718293a4b5c6d7e8f9012a3b4c5d' },
      },
    });
  });

  it('parses a pull_request action we do not act on instead of refusing it', () => {
    const closed = JSON.stringify({ ...JSON.parse(pullRequestOpenedFixture), action: 'closed' });
    expect(parseWebhook('pull_request', closed)).toMatchObject({ kind: 'pull_request', data: { action: 'closed' } });
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
