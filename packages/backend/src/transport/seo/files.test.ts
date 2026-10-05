import { describe, expect, it } from 'vitest';

import { HelpSiteNotFoundError } from '@backend/domain/helpcenter/errors';
import { helpSiteForHost, helpSiteOrigin } from '@backend/domain/helpcenter/site-url';
import { seoFile, SeoFiles } from '@backend/transport/seo/files';

import type { SeoFileDeps } from '@backend/transport/seo/files';

const env = { HELP_SITES_DOMAIN: 'help.mocco.club', HELP_CUSTOM_DOMAINS: 'help.syt.app=syt' };

const deps = (overrides: Partial<SeoFileDeps> = {}): SeoFileDeps => ({
  appOrigin: 'https://www.mocco.club',
  appPages: () => [
    { path: '/', lastModified: null },
    { path: '/docs/start/overview', lastModified: new Date('2026-10-04T00:00:00Z') },
  ],
  helpSiteForHost: host => helpSiteForHost(host, env),
  helpSiteOrigin: slug => helpSiteOrigin(slug, env),
  help: {
    site: async slug => {
      if (slug !== 'syt' && slug !== 'acme') {
        throw new HelpSiteNotFoundError(slug);
      }
      return await Promise.resolve({
        slug,
        name: 'ShowYourTime',
        sourceLocale: 'ko',
        locales: ['en'],
        allowAiTraining: slug === 'syt',
      });
    },
    sitemap: async slug => {
      if (slug !== 'syt' && slug !== 'acme') {
        throw new HelpSiteNotFoundError(slug);
      }
      return await Promise.resolve({
        sourceLocale: 'ko',
        homes: [
          { locale: 'ko', path: '/ko' },
          { locale: 'en', path: '/en' },
        ],
        articles: [
          [
            { locale: 'ko', path: '/ko/articles/abc123-widget', lastModified: new Date('2026-10-01T00:00:00Z') },
            { locale: 'en', path: '/en/articles/abc123-widget', lastModified: new Date('2026-10-02T00:00:00Z') },
          ],
          [{ locale: 'ko', path: '/ko/articles/def456-a&b', lastModified: null }],
        ],
      });
    },
  },
  indexNowKeyOf: slug => `key-for-${slug}`,
  ...overrides,
});

describe('helpSiteForHost', () => {
  it('maps a custom domain and a Mocco subdomain to their site, and anything else to the app', () => {
    expect(helpSiteForHost('help.syt.app', env)).toBe('syt');
    expect(helpSiteForHost('HELP.SYT.APP:443', env)).toBe('syt');
    expect(helpSiteForHost('acme.help.mocco.club', env)).toBe('acme');
    expect(helpSiteForHost('www.mocco.club', env)).toBeNull();
    expect(helpSiteForHost('a.b.help.mocco.club', env)).toBeNull();
    expect(helpSiteForHost('help.mocco.club', env)).toBeNull();
    expect(helpSiteForHost('acme.help.mocco.club', {})).toBeNull();
  });
});

describe('seoFile', () => {
  it("keeps crawlers out of the app's console and points them at its sitemap", async () => {
    const file = await seoFile(SeoFiles.robots, 'www.mocco.club', deps());

    expect(file.contentType).toContain('text/plain');
    expect(file.body).toContain('User-agent: *\nAllow: /\nDisallow: /workspaces\n');
    expect(file.body).toContain('Sitemap: https://www.mocco.club/sitemap.xml');
  });

  it("lists the app's public pages with their dates", async () => {
    const file = await seoFile(SeoFiles.sitemap, 'www.mocco.club', deps());

    expect(file.contentType).toContain('application/xml');
    expect(file.body).toContain('<loc>https://www.mocco.club/</loc>');
    expect(file.body).toContain(
      '<loc>https://www.mocco.club/docs/start/overview</loc>\n    <lastmod>2026-10-04T00:00:00.000Z</lastmod>',
    );
  });

  it("answers a help site's robots.txt on its canonical origin, without its search page", async () => {
    const file = await seoFile(SeoFiles.robots, 'syt.help.mocco.club', deps());

    expect(file.status).toBe(200);
    expect(file.body).toContain('Disallow: /*/search');
    // The site has a custom domain, so that is where its sitemap lives.
    expect(file.body).toContain('Sitemap: https://help.syt.app/sitemap.xml');
  });

  it('keeps AI training crawlers out of a site that says so, and lets search crawlers in', async () => {
    const allowed = await seoFile(SeoFiles.robots, 'help.syt.app', deps());
    const refused = await seoFile(SeoFiles.robots, 'acme.help.mocco.club', deps());

    expect(allowed.body).not.toContain('GPTBot');
    expect(refused.body).toContain('User-agent: GPTBot\nUser-agent: ClaudeBot\n');
    expect(refused.body).toContain('User-agent: Bytespider\nDisallow: /\n');
    expect(refused.body).not.toContain('OAI-SearchBot');
    expect(refused.body).toContain('Sitemap: https://acme.help.mocco.club/sitemap.xml');
  });

  it('lists every language version of each help page with reciprocal hreflang and x-default', async () => {
    const file = await seoFile(SeoFiles.sitemap, 'help.syt.app', deps());
    const alternates = [
      '<xhtml:link rel="alternate" hreflang="ko" href="https://help.syt.app/ko/articles/abc123-widget"/>',
      '<xhtml:link rel="alternate" hreflang="en" href="https://help.syt.app/en/articles/abc123-widget"/>',
      '<xhtml:link rel="alternate" hreflang="x-default" href="https://help.syt.app/ko/articles/abc123-widget"/>',
    ].join('\n    ');

    expect(file.body).toContain(
      `<loc>https://help.syt.app/ko/articles/abc123-widget</loc>\n    <lastmod>2026-10-01T00:00:00.000Z</lastmod>\n    ${alternates}`,
    );
    expect(file.body).toContain(
      `<loc>https://help.syt.app/en/articles/abc123-widget</loc>\n    <lastmod>2026-10-02T00:00:00.000Z</lastmod>\n    ${alternates}`,
    );
    expect(file.body).toContain('hreflang="en" href="https://help.syt.app/en"/>');
    // A page in one language has no alternates, and its URL is escaped.
    expect(file.body).toContain('<loc>https://help.syt.app/ko/articles/def456-a&amp;b</loc>\n  </url>');
  });

  it("serves a help site's IndexNow key on its host, and none on the app's", async () => {
    const help = await seoFile(SeoFiles.indexNowKey, 'help.syt.app', deps());
    const app = await seoFile(SeoFiles.indexNowKey, 'www.mocco.club', deps());

    expect([help.status, help.body]).toEqual([200, 'key-for-syt']);
    expect(app.status).toBe(404);
  });

  it('answers 404 for a help host with no such site', async () => {
    const sitemap = await seoFile(SeoFiles.sitemap, 'gone.help.mocco.club', deps());
    const robots = await seoFile(SeoFiles.robots, 'gone.help.mocco.club', deps());

    expect([sitemap.status, robots.status]).toEqual([404, 404]);
  });
});
