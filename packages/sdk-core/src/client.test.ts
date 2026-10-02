import { describe, expect, it } from 'vitest';

import { MoccoClient } from './client';
import { MoccoError, MoccoKeyError } from './errors';

const responses = (...items: Response[]) => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return await Promise.resolve(items[Math.min(calls.length - 1, items.length - 1)] ?? new Response(null));
  };
  return { calls, fetch: fetchImpl };
};

const problem = (status: number, code: string, headers: Record<string, string> = {}) =>
  Response.json(
    { type: `https://mocco.dev/problems/${code}`, title: code, status, detail: `${code} detail` },
    { status, headers: { 'content-type': 'application/problem+json', ...headers } },
  );

const client = (fetchImpl: typeof fetch, key = 'mk_sec_0123456789abcdefghijklmnopqrstuv') =>
  new MoccoClient({ key, fetch: fetchImpl, isBrowser: false, sleep: async () => {} });

describe('MoccoClient', () => {
  it('sends the key and parses the answer', async () => {
    const mocco = responses(Response.json({ projectId: 'p', kind: 'secret', scopes: ['ota:write'] }));

    const whoami = await client(mocco.fetch).whoami();

    expect(whoami).toEqual({ projectId: 'p', kind: 'secret', scopes: ['ota:write'] });
    expect(mocco.calls[0]?.url).toBe('https://api.mocco.club/v1/whoami');
    expect(new Headers(mocco.calls[0]?.init?.headers).get('authorization')).toMatch(/^Bearer mk_sec_/u);
  });

  it('retries a GET on 429 and 503, then turns a refusal into a MoccoError with its code', async () => {
    const retried = responses(
      problem(429, 'rate_limited', { 'retry-after': '1' }),
      problem(503, 'unavailable'),
      Response.json({ ok: true }),
    );
    expect(await client(retried.fetch).request('GET', '/ping')).toEqual({ ok: true });
    expect(retried.calls).toHaveLength(3);

    const refused = responses(problem(401, 'invalid_key'));
    const request = client(refused.fetch).request('GET', '/whoami');
    await expect(request).rejects.toBeInstanceOf(MoccoError);
    await expect(client(responses(problem(401, 'invalid_key')).fetch).request('GET', '/whoami')).rejects.toMatchObject({
      status: 401,
      code: 'invalid_key',
      message: 'invalid_key detail',
    });
  });

  it('sends If-None-Match on a conditional GET and resolves a 304 without a body', async () => {
    const mocco = responses(
      Response.json({ flags: {} }, { headers: { etag: '"v1"' } }),
      new Response(null, { status: 304, headers: { etag: '"v1"' } }),
    );
    const api = client(mocco.fetch);

    const first = await api.getIfChanged('/flags/ruleset', null);
    const second = await api.getIfChanged('/flags/ruleset', '"v1"');

    expect(first).toEqual({ modified: true, body: { flags: {} }, etag: '"v1"' });
    expect(second).toEqual({ modified: false });
    expect(new Headers(mocco.calls[0]?.init?.headers).has('if-none-match')).toBe(false);
    expect(new Headers(mocco.calls[1]?.init?.headers).get('if-none-match')).toBe('"v1"');
  });

  it("doesn't retry a POST without an idempotency key", async () => {
    const mocco = responses(problem(503, 'unavailable'), Response.json({ ok: true }));

    await expect(client(mocco.fetch).request('POST', '/things', { body: {} })).rejects.toThrow(MoccoError);
    expect(mocco.calls).toHaveLength(1);
  });

  it('refuses a secret key in a browser and anything that is not a Mocco key', () => {
    const { fetch: fetchImpl } = responses();
    expect(() => new MoccoClient({ key: 'mk_sec_x', fetch: fetchImpl, isBrowser: true })).toThrow(MoccoKeyError);
    expect(() => new MoccoClient({ key: 'sk_live_x', fetch: fetchImpl, isBrowser: false })).toThrow(
      /not a Mocco API key/u,
    );
    expect(new MoccoClient({ key: 'mk_pub_x', fetch: fetchImpl, isBrowser: true }).keyKind).toBe('publishable');
  });
});
