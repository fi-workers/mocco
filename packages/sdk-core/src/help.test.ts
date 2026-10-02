import { describe, expect, it, vi } from 'vitest';

import { MoccoError } from './errors';
import { HelpClient } from './help';

const hit = {
  title: 'Widget',
  path: '/en/articles/abc123-widget',
  url: 'https://help.test/en/articles/abc123-widget',
  snippet: 'Tap',
};

describe('HelpClient', () => {
  it('searches with the key, locale and limit, and skips empty queries', async () => {
    const fetchSpy = vi.fn(async () => await Promise.resolve(Response.json({ locale: 'en', hits: [hit] })));
    const help = new HelpClient({ publishableKey: 'mk_pub_x', baseUrl: 'https://mocco.test/v1/', fetch: fetchSpy });

    expect(await help.search('  widget  ', { locale: 'en', limit: 3 })).toEqual([hit]);
    expect(await help.search(' '.repeat(3))).toEqual([]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://mocco.test/v1/help/search?q=widget&locale=en&limit=3');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer mk_pub_x');
  });

  it('asks for any-word matching', async () => {
    const fetchSpy = vi.fn(async () => await Promise.resolve(Response.json({ locale: 'ko', hits: [] })));
    const help = new HelpClient({ publishableKey: 'mk_pub_x', fetch: fetchSpy });

    await help.search('위젯이 안 보여요', { match: 'any' });

    const [url] = fetchSpy.mock.calls[0] as unknown as [string];
    expect(new URL(url).searchParams.get('match')).toBe('any');
  });

  it('throws MoccoError on a refusal', async () => {
    const help = new HelpClient({
      publishableKey: 'mk_pub_x',
      fetch: async () => await Promise.resolve(new Response('{}', { status: 403 })),
    });
    await expect(help.search('x')).rejects.toBeInstanceOf(MoccoError);
  });
});
