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

const notFound = async () =>
  await Promise.resolve(
    Response.json({ type: 'https://mocco.dev/problems/not_found', title: 'Not found' }, { status: 404 }),
  );

describe('HelpClient reads', () => {
  const site = { name: 'Acme', sourceLocale: 'ko', locales: ['en'], locale: 'en', url: null, collections: [] };
  const article = {
    id: 'abc123',
    slug: 'widget',
    locale: 'ko',
    title: '위젯',
    body: '길게 누르세요.',
    path: '/ko/articles/abc123-widget',
    url: null,
    locales: ['ko'],
    publishedAt: '2026-10-05T00:00:00.000Z',
    updatedAt: '2026-10-05T00:00:00.000Z',
  };

  it('reads the site, a collection and an article with the locale', async () => {
    const fetchSpy = vi.fn(async (url: RequestInfo | URL) => {
      const { pathname } = new URL(String(url));
      if (pathname.endsWith('/site')) {
        return await Promise.resolve(Response.json(site));
      }
      if (pathname.includes('/collections/')) {
        return await Promise.resolve(Response.json({ locale: 'en', collection: { slug: 'start' } }));
      }
      return await Promise.resolve(Response.json(article));
    });
    const help = new HelpClient({ publishableKey: 'mk_pub_x', baseUrl: 'https://mocco.test/v1', fetch: fetchSpy });

    expect(await help.getSite({ locale: 'en-US' })).toEqual(site);
    expect(await help.getCollection('start')).toEqual({ slug: 'start' });
    expect(await help.getArticle('abc123', { locale: 'en' })).toEqual(article);
    expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([
      'https://mocco.test/v1/help/site?locale=en-US',
      'https://mocco.test/v1/help/collections/start',
      'https://mocco.test/v1/help/articles/abc123?locale=en',
    ]);
  });

  it('answers null for an unpublished article or collection, and throws for a missing help center', async () => {
    const help = new HelpClient({ publishableKey: 'mk_pub_x', fetch: notFound });

    expect(await help.getArticle('abc123')).toBeNull();
    expect(await help.getCollection('start')).toBeNull();
    await expect(help.getSite()).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });

  it('sends feedback with the client’s visitor id', async () => {
    const fetchSpy = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        await Promise.resolve(Response.json({ counted: true }, { status: 201 })),
    );
    const help = new HelpClient({
      publishableKey: 'mk_pub_x',
      baseUrl: 'https://mocco.test/v1',
      fetch: fetchSpy,
      visitorId: 'install-1234',
    });

    expect(await help.sendFeedback('abc123', { helpful: true, locale: 'en' })).toEqual({ counted: true });
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect([url, init?.method, JSON.parse(String(init?.body))]).toEqual([
      'https://mocco.test/v1/help/articles/abc123/feedback',
      'POST',
      { helpful: true, locale: 'en', visitorId: 'install-1234' },
    ]);
  });
});
