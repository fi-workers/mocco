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

  it('answers 404 for a help host with no such site', async () => {
    const file = await seoFile(SeoFiles.sitemap, 'gone.help.mocco.club', deps());

    expect(file.status).toBe(404);
  });
});
