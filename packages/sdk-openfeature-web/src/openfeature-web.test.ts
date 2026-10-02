import { randomUUID } from 'node:crypto';

import { OpenFeature } from '@openfeature/web-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MoccoWebProvider } from './openfeature-web';

const KEY = 'mk_pub_0123456789abcdefghijklmnopqrstuv';

const bulk = {
  flags: [
    { key: 'new-checkout', value: true, variant: 'on', reason: 'TARGETING_MATCH' },
    { key: 'checkout-copy', value: 'Pay', variant: 'short', reason: 'STATIC' },
  ],
};

/** A fake Mocco that records each request. */
function fakeMocco() {
  const requests: { url: string; headers: Headers; body: unknown }[] = [];
  const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push({ url: request.url, headers: request.headers, body: await request.json() });
    return Response.json(bulk, { headers: { etag: '"e1"' } });
  });
  return { requests, fetch: fetchSpy };
}

describe('MoccoWebProvider', () => {
  afterEach(async () => {
    await OpenFeature.clearProviders();
  });

  it('evaluates through Mocco OFREP with the publishable key', async () => {
    const mocco = fakeMocco();
    const domain = `test-${randomUUID()}`;
    const provider = new MoccoWebProvider({
      publishableKey: KEY,
      baseUrl: 'https://mocco.test/v1/',
      fetchImplementation: mocco.fetch,
      cacheMode: 'disabled',
      changeDetection: 'none',
      disableVisibilityRefresh: true,
    });
    await OpenFeature.setContext(domain, { targetingKey: 'u1', plan: 'pro' });
    await OpenFeature.setProviderAndWait(domain, provider);
    const client = OpenFeature.getClient(domain);

    expect(provider.metadata.name).toBe('Mocco');
    expect(client.getBooleanDetails('new-checkout', false)).toMatchObject({ value: true, reason: 'TARGETING_MATCH' });
    expect(client.getStringValue('checkout-copy', 'fallback')).toBe('Pay');
    expect(mocco.requests[0]).toMatchObject({
      url: 'https://mocco.test/v1/ofrep/v1/evaluate/flags',
      body: { context: { targetingKey: 'u1', plan: 'pro' } },
    });
    expect(mocco.requests[0]?.headers.get('authorization')).toBe(`Bearer ${KEY}`);
  });

  it('refuses a secret key or a non-key', () => {
    expect(() => new MoccoWebProvider({ publishableKey: 'mk_sec_0123456789abcdefghijklmnopqrstuv' })).toThrow(
      /publishable key/u,
    );
    expect(() => new MoccoWebProvider({ publishableKey: 'nope' })).toThrow(/publishable key/u);
  });
});
