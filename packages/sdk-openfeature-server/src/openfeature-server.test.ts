import { randomUUID } from 'node:crypto';

import { OpenFeature, ProviderEvents, ProviderStatus } from '@openfeature/server-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MoccoProvider } from './openfeature-server';

const KEY = 'mk_sec_0123456789abcdefghijklmnopqrstuv';

const ruleset = (isEnabled: boolean, version: number) => ({
  $schema: 'https://flagd.dev/schema/v0/flags.json',
  metadata: { 'mocco.environment': 'production', 'mocco.version': version, 'mocco.bucketing': 'mocco-v1' },
  flags: {
    'new-checkout': {
      state: isEnabled ? 'ENABLED' : 'DISABLED',
      variants: { on: true, off: false },
      defaultVariant: 'on',
      targeting: {},
      metadata: { 'mocco.offVariant': 'off', 'mocco.killed': false },
    },
    'checkout-copy': {
      state: 'ENABLED',
      variants: { short: 'Pay', long: 'Pay securely' },
      defaultVariant: 'short',
      targeting: { if: [{ ends_with: [{ var: 'email' }, '@acme.test'] }, 'long', null] },
    },
  },
});

/** An answer that serves `body` with `etag`. */
const serve = (body: unknown, etag: string) => () => Response.json(body, { headers: { etag } });

/** A fake Mocco: answers with `next()` and records each request's If-None-Match. */
function fakeMocco() {
  const requests: (string | null)[] = [];
  const state = { next: (): Response | Error => new Error('not set') };
  const fetchSpy = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    requests.push(new Headers(init?.headers).get('if-none-match'));
    const answer = state.next();
    if (answer instanceof Error) {
      throw answer;
    }
    return await Promise.resolve(answer);
  });
  return { requests, state, fetch: fetchSpy, serve };
}

describe('MoccoProvider', () => {
  let domain: string;

  beforeEach(() => {
    vi.useFakeTimers();
    domain = `test-${randomUUID()}`;
  });
  afterEach(async () => {
    await OpenFeature.clearProviders();
    vi.useRealTimers();
  });

  it('evaluates locally from the polled ruleset, with no network call per evaluation', async () => {
    const mocco = fakeMocco();
    mocco.state.next = serve(ruleset(true, 2), '"v2"');
    const provider = new MoccoProvider({ secretKey: KEY, fetch: mocco.fetch });
    await OpenFeature.setProviderAndWait(domain, provider);
    const client = OpenFeature.getClient(domain);
    const callsAfterInit = mocco.fetch.mock.calls.length;

    const values = await Promise.all(
      Array.from(
        { length: 50 },
        async (_, index) => await client.getBooleanValue('new-checkout', false, { targetingKey: `u${index}` }),
      ),
    );
    const copy = await client.getStringDetails('checkout-copy', 'Pay', { targetingKey: 'u1', email: 'ada@acme.test' });
    const missing = await client.getBooleanDetails('nope', true);

    expect(values.every(Boolean)).toBe(true);
    expect(copy).toMatchObject({ value: 'Pay securely', variant: 'long', reason: 'TARGETING_MATCH' });
    expect(missing).toMatchObject({ value: true, errorCode: 'FLAG_NOT_FOUND' });
    expect(mocco.fetch.mock.calls).toHaveLength(callsAfterInit);
  });

  it('polls with If-None-Match and announces changed flags', async () => {
    const mocco = fakeMocco();
    mocco.state.next = serve(ruleset(false, 1), '"v1"');
    const provider = new MoccoProvider({ secretKey: KEY, fetch: mocco.fetch, pollIntervalMs: 1000 });
    await OpenFeature.setProviderAndWait(domain, provider);
    const client = OpenFeature.getClient(domain);
    const changes: unknown[] = [];
    client.addHandler(ProviderEvents.ConfigurationChanged, details => {
      changes.push(details?.flagsChanged);
    });

    mocco.state.next = () => new Response(null, { status: 304, headers: { etag: '"v1"' } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await client.getBooleanValue('new-checkout', true)).toBe(true);

    mocco.state.next = serve(ruleset(true, 2), '"v2"');
    await vi.advanceTimersByTimeAsync(1000);

    expect(mocco.requests).toEqual([null, '"v1"', '"v1"']);
    expect(changes).toEqual([['new-checkout']]);
    expect(await client.getBooleanDetails('new-checkout', false)).toMatchObject({ value: true, reason: 'STATIC' });
  });

  it('keeps serving the last good ruleset while Mocco is down, as STALE, and recovers', async () => {
    const mocco = fakeMocco();
    mocco.state.next = serve(ruleset(true, 2), '"v2"');
    const provider = new MoccoProvider({ secretKey: KEY, fetch: mocco.fetch, pollIntervalMs: 1000 });
    await OpenFeature.setProviderAndWait(domain, provider);
    const client = OpenFeature.getClient(domain);
    const events: string[] = [];
    client.addHandler(ProviderEvents.Stale, () => {
      events.push('stale');
    });
    client.addHandler(ProviderEvents.Ready, () => {
      events.push('ready');
    });

    mocco.state.next = () => new TypeError('fetch failed');
    await vi.advanceTimersByTimeAsync(3000);
    const isWhileDown = await client.getBooleanValue('new-checkout', false);
    const statusWhileDown = client.providerStatus;
    mocco.state.next = () => new Response(null, { status: 304, headers: { etag: '"v2"' } });
    await vi.advanceTimersByTimeAsync(1000);

    expect(isWhileDown).toBe(true);
    expect(statusWhileDown).toBe(ProviderStatus.STALE);
    // The first 'ready' is OpenFeature running a READY handler added to a ready provider.
    expect(events).toEqual(['ready', 'stale', 'ready']);
    expect(client.providerStatus).toBe(ProviderStatus.READY);
  });

  it('starts from a bootstrap when Mocco is unreachable, and fails without one', async () => {
    const mocco = fakeMocco();
    mocco.state.next = () => new TypeError('fetch failed');

    const bootstrapped = new MoccoProvider({ secretKey: KEY, fetch: mocco.fetch, bootstrap: ruleset(true, 1) });
    await OpenFeature.setProviderAndWait(domain, bootstrapped);
    const isFromBootstrap = await OpenFeature.getClient(domain).getBooleanValue('new-checkout', false);

    const bare = new MoccoProvider({ secretKey: KEY, fetch: mocco.fetch });
    await expect(OpenFeature.setProviderAndWait(`${domain}-bare`, bare)).rejects.toThrow(
      /Couldn't load the Mocco ruleset/u,
    );
    const notReady = await OpenFeature.getClient(`${domain}-bare`).getBooleanDetails('new-checkout', false);

    expect(isFromBootstrap).toBe(true);
    expect(notReady).toMatchObject({ value: false, errorCode: 'PROVIDER_NOT_READY' });
    expect(() => new MoccoProvider({ secretKey: KEY, bootstrap: { flags: { a: { state: 'ON' } } } })).toThrow(
      /invalid/u,
    );
  });

  it('keeps the last good ruleset when Mocco serves one it cannot use', async () => {
    const mocco = fakeMocco();
    mocco.state.next = serve(ruleset(true, 2), '"v2"');
    const provider = new MoccoProvider({ secretKey: KEY, fetch: mocco.fetch, pollIntervalMs: 1000 });
    await OpenFeature.setProviderAndWait(domain, provider);
    const client = OpenFeature.getClient(domain);

    mocco.state.next = serve({ flags: { 'new-checkout': { state: 'ENABLED', targeting: { map: [] } } } }, '"v3"');
    await vi.advanceTimersByTimeAsync(1000);

    expect(await client.getBooleanValue('new-checkout', false)).toBe(true);
    expect(client.providerStatus).toBe(ProviderStatus.STALE);
    expect(mocco.requests.at(-1)).toBe('"v2"');
  });
});
