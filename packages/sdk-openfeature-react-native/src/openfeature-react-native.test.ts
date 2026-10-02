import { randomUUID } from 'node:crypto';

import { OpenFeature, ProviderEvents, ProviderStatus } from '@openfeature/web-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MoccoReactNativeProvider } from './openfeature-react-native';

import type { EventSourceLike, KeyValueStorage, MoccoReactNativeProviderOptions } from './openfeature-react-native';

const KEY = 'mk_pub_0123456789abcdefghijklmnopqrstuv';
const STREAM_URL = 'https://mocco.test/v1/flags/stream?token=t1';

const evaluation = (isOn: boolean) => ({
  flags: [
    { key: 'new-checkout', value: isOn, variant: isOn ? 'on' : 'off', reason: 'TARGETING_MATCH' },
    { key: 'checkout-copy', value: 'Pay', variant: 'short', reason: 'STATIC' },
    { key: 'paused', reason: 'DISABLED' },
    { key: 'broken', errorCode: 'PARSE_ERROR', errorDetails: 'bad context' },
  ],
  eventStreams: [{ type: 'sse', url: STREAM_URL }],
});

/** A fake Mocco: answers with `next()` and records each request. */
function fakeMocco() {
  const requests: { ifNoneMatch: string | null; context: unknown }[] = [];
  const state = { next: (): Response | Error => new Error('offline') };
  const fetchSpy = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { context: unknown };
    requests.push({ ifNoneMatch: new Headers(init?.headers).get('if-none-match'), context: body.context });
    const answer = state.next();
    if (answer instanceof Error) {
      throw answer;
    }
    return await Promise.resolve(answer);
  });
  return { requests, state, fetch: fetchSpy };
}

const ok = (isOn: boolean, etag: string) => () => Response.json(evaluation(isOn), { headers: { etag } });
const notModified = () => new Response(null, { status: 304 });

function memoryStorage(): KeyValueStorage & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    getItem: async key => await Promise.resolve(items.get(key) ?? null),
    setItem: async (key, value) => {
      items.set(key, value);
      await Promise.resolve();
    },
  };
}

function fakeAppState() {
  const state: { listener?: (next: string) => void } = {};
  return {
    set: (next: string) => {
      state.listener?.(next);
    },
    addEventListener: (_type: 'change', listener: (next: string) => void) => {
      state.listener = listener;
      return {
        remove: () => {
          delete state.listener;
        },
      };
    },
  };
}

/** A fake EventSource that records the streams opened. */
function fakeEventSource() {
  const opened: { url: string; isClosed: boolean; emit: (type: 'message' | 'error', data?: unknown) => void }[] = [];
  class FakeEventSource implements EventSourceLike {
    private readonly listeners = new Map<string, (event: { data?: unknown }) => void>();

    private readonly record: (typeof opened)[number];

    constructor(url: string) {
      this.record = {
        url,
        isClosed: false,
        emit: (type, data) => {
          this.listeners.get(type)?.({ data });
        },
      };
      opened.push(this.record);
    }

    close(): void {
      this.record.isClosed = true;
    }

    addEventListener(type: 'message' | 'error', listener: (event: { data?: unknown }) => void): void {
      this.listeners.set(type, listener);
    }
  }
  return { opened, EventSource: FakeEventSource };
}

describe('MoccoReactNativeProvider', () => {
  let domain: string;

  beforeEach(() => {
    domain = `test-${randomUUID()}`;
  });
  afterEach(async () => {
    await OpenFeature.clearProviders();
    vi.useRealTimers();
  });

  const start = async (options: Partial<MoccoReactNativeProviderOptions>) => {
    const provider = new MoccoReactNativeProvider({
      publishableKey: KEY,
      baseUrl: 'https://mocco.test/v1',
      ...options,
    });
    await OpenFeature.setContext(domain, { targetingKey: 'u1' });
    await OpenFeature.setProviderAndWait(domain, provider);
    return { provider, client: OpenFeature.getClient(domain) };
  };

  it('resolves values, disabled flags, errors, missing flags and type mismatches', async () => {
    const mocco = fakeMocco();
    mocco.state.next = ok(true, '"e1"');
    const { client } = await start({ fetch: mocco.fetch, pollIntervalMs: 0 });

    expect(client.getBooleanDetails('new-checkout', false)).toMatchObject({
      value: true,
      variant: 'on',
      reason: 'TARGETING_MATCH',
    });
    expect(client.getStringValue('checkout-copy', 'fallback')).toBe('Pay');
    expect(client.getBooleanDetails('paused', true)).toMatchObject({ value: true, reason: 'DISABLED' });
    expect(client.getBooleanDetails('broken', false)).toMatchObject({ value: false, errorCode: 'PARSE_ERROR' });
    expect(client.getBooleanDetails('missing', false)).toMatchObject({ errorCode: 'FLAG_NOT_FOUND' });
    expect(client.getNumberDetails('checkout-copy', 1)).toMatchObject({ value: 1, errorCode: 'TYPE_MISMATCH' });
    expect(mocco.requests).toEqual([{ ifNoneMatch: null, context: { targetingKey: 'u1' } }]);
  });

  it('restores the last evaluation offline and recovers when Mocco answers again', async () => {
    const storage = memoryStorage();
    const online = fakeMocco();
    online.state.next = ok(true, '"e1"');
    await start({ fetch: online.fetch, storage, pollIntervalMs: 0 });
    expect(storage.items.size).toBe(1);
    await OpenFeature.clearProviders();

    // Next launch, offline: initialized from the stored copy, then STALE when the fetch fails.
    const offline = fakeMocco();
    const appState = fakeAppState();
    const { client } = await start({ fetch: offline.fetch, storage, appState, pollIntervalMs: 0 });
    expect(client.getBooleanDetails('new-checkout', false)).toMatchObject({ value: true, variant: 'on' });
    await vi.waitFor(() => {
      expect(client.providerStatus).toBe(ProviderStatus.STALE);
    });
    expect(offline.requests[0]?.ifNoneMatch).toBe('"e1"');

    // Back online with a change: the next foreground fetch makes it READY with the new value.
    offline.state.next = ok(false, '"e2"');
    appState.set('background');
    appState.set('active');
    await vi.waitFor(() => {
      expect(client.providerStatus).toBe(ProviderStatus.READY);
    });
    expect(client.getBooleanValue('new-checkout', true)).toBe(false);
  });

  it('fails to initialize with neither a stored copy nor Mocco', async () => {
    const mocco = fakeMocco();
    const provider = new MoccoReactNativeProvider({ publishableKey: KEY, fetch: mocco.fetch, pollIntervalMs: 0 });
    await expect(OpenFeature.setProviderAndWait(domain, provider)).rejects.toThrow();
    expect(OpenFeature.getClient(domain).getBooleanDetails('new-checkout', false)).toMatchObject({
      value: false,
      errorCode: 'PROVIDER_NOT_READY',
    });
  });

  it('polls with the ETag while active, and refreshes on returning to the foreground', async () => {
    vi.useFakeTimers();
    const mocco = fakeMocco();
    const appState = fakeAppState();
    mocco.state.next = ok(true, '"e1"');
    const { client } = await start({ fetch: mocco.fetch, appState, pollIntervalMs: 60_000 });
    const changed = vi.fn();
    client.addHandler(ProviderEvents.ConfigurationChanged, changed);

    mocco.state.next = notModified;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocco.requests.at(-1)?.ifNoneMatch).toBe('"e1"');
    expect(changed).not.toHaveBeenCalled();

    // In the background nothing is fetched; coming back fetches at once.
    appState.set('background');
    await vi.advanceTimersByTimeAsync(180_000);
    expect(mocco.requests).toHaveLength(2);
    mocco.state.next = ok(false, '"e2"');
    appState.set('active');
    await vi.waitFor(() => {
      expect(client.getBooleanValue('new-checkout', true)).toBe(false);
    });
    expect(mocco.requests).toHaveLength(3);
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ flagsChanged: ['new-checkout'] }));
  });

  it('re-fetches on a change-stream event, and reconnects with a fresh URL after an error', async () => {
    vi.useFakeTimers();
    const mocco = fakeMocco();
    const streams = fakeEventSource();
    mocco.state.next = ok(true, '"e1"');
    const { client } = await start({ fetch: mocco.fetch, EventSource: streams.EventSource, pollIntervalMs: 0 });
    expect(streams.opened.map(stream => stream.url)).toEqual([STREAM_URL]);

    mocco.state.next = ok(false, '"e2"');
    streams.opened[0]?.emit('message', JSON.stringify({ type: 'refetchEvaluation', etag: '"e2"' }));
    await vi.waitFor(() => {
      expect(client.getBooleanValue('new-checkout', true)).toBe(false);
    });
    expect(mocco.requests.at(-1)?.ifNoneMatch).toBe('"e1"');

    // The stream drops (expiry, server close): a full re-fetch after the backoff reconnects.
    streams.opened[0]?.emit('error');
    expect(streams.opened[0]?.isClosed).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocco.requests.at(-1)?.ifNoneMatch).toBeNull();
    expect(streams.opened).toHaveLength(2);
  });

  it('re-evaluates on a context change, from the stored copy first', async () => {
    const storage = memoryStorage();
    const mocco = fakeMocco();
    mocco.state.next = ok(true, '"e1"');
    const { client } = await start({ fetch: mocco.fetch, storage, pollIntervalMs: 0 });

    mocco.state.next = ok(false, '"e2"');
    await OpenFeature.setContext(domain, { targetingKey: 'u2' });
    expect(client.getBooleanValue('new-checkout', true)).toBe(false);
    expect(mocco.requests.at(-1)).toEqual({ ifNoneMatch: null, context: { targetingKey: 'u2' } });
    expect(storage.items.size).toBe(2);
  });

  it('counts reads and sends them when the app goes to the background', async () => {
    const reports: unknown[] = [];
    const mocco = fakeMocco();
    mocco.state.next = ok(true, '"e1"');
    const fetchWithTelemetry = async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/flags/telemetry')) {
        reports.push(JSON.parse(String(init?.body)));
        return new Response(null, { status: 202 });
      }
      return await mocco.fetch(input, init);
    };
    const appState = fakeAppState();
    const { client } = await start({ fetch: fetchWithTelemetry, appState, pollIntervalMs: 0 });
    client.getBooleanValue('new-checkout', false);
    client.getBooleanValue('new-checkout', false);
    client.getBooleanValue('paused', false);
    client.getBooleanValue('missing', false);

    appState.set('background');
    await vi.waitFor(() => {
      expect(reports).toHaveLength(1);
    });
    expect(reports[0]).toEqual({
      evaluations: [
        { flag: 'new-checkout', variant: 'on', count: 2, windowStart: expect.any(String) },
        { flag: 'paused', variant: null, count: 1, windowStart: expect.any(String) },
      ],
    });
  });

  it('refuses a secret key', () => {
    expect(() => new MoccoReactNativeProvider({ publishableKey: 'mk_sec_0123456789abcdefghijklmnopqrstuv' })).toThrow(
      /publishable key/u,
    );
  });
});
