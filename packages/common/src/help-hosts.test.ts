import { describe, expect, it } from 'vitest';

import { appHostOriginFor, appHostSiteOf, helpCustomDomainsOf, helpHostRoutes } from '@mocco/common/help-hosts';

const today = {
  SERVICE_DOMAIN: 'www.mocco.club',
  HELP_SITES_DOMAIN: 'help.mocco.club',
  HELP_CUSTOM_DOMAINS: 'help.syt.app=syt, docs.mocco.club=mocco',
};
const mounted = { ...today, HELP_APP_HOST_SITE: 'mocco' };

describe('appHostSiteOf', () => {
  it('is the slug when it is valid and there is an app host to mount it on', () => {
    expect(appHostSiteOf(mounted)).toBe('mocco');
    expect(appHostSiteOf({ ...mounted, HELP_APP_HOST_SITE: ' mocco ' })).toBe('mocco');
    expect(appHostSiteOf(today)).toBeNull();
    expect(appHostSiteOf({ HELP_APP_HOST_SITE: 'mocco' })).toBeNull();
    expect(appHostSiteOf({ ...mounted, HELP_APP_HOST_SITE: 'Not a slug' })).toBeNull();
  });

  it("gives the app's origin for that site only", () => {
    expect(appHostOriginFor('mocco', mounted)).toBe('https://www.mocco.club');
    expect(appHostOriginFor('syt', mounted)).toBeNull();
    expect(appHostOriginFor('mocco', { SERVICE_DOMAIN: 'localhost:3326', HELP_APP_HOST_SITE: 'mocco' })).toBe(
      'http://localhost:3326',
    );
  });
});

describe('helpCustomDomainsOf', () => {
  it('parses domain=slug pairs and skips malformed ones', () => {
    expect(helpCustomDomainsOf({ HELP_CUSTOM_DOMAINS: 'a.com=a, =b, c.com=Bad Slug,d.com' })).toEqual([
      { domain: 'a.com', site: 'a' },
    ]);
  });
});

describe('helpHostRoutes', () => {
  it('serves each site on its subdomain and custom domains, with no redirects, when nothing is mounted', () => {
    const routes = helpHostRoutes(today);

    expect(routes.redirects).toEqual([]);
    expect(routes.rewrites).toEqual([
      {
        source: '/:path((?!_next/|api/|favicon).*)',
        has: [{ type: 'host', value: String.raw`^(?<site>[a-z0-9-]+)\.help\.mocco\.club$` }],
        destination: '/_sites/:site/:path',
      },
      {
        source: '/:path((?!_next/|api/|favicon).*)',
        has: [{ type: 'host', value: String.raw`^help\.syt\.app$` }],
        destination: '/_sites/syt/:path',
      },
      {
        source: '/:path((?!_next/|api/|favicon).*)',
        has: [{ type: 'host', value: String.raw`^docs\.mocco\.club$` }],
        destination: '/_sites/mocco/:path',
      },
    ]);
  });

  it('has no routes at all without help hosts', () => {
    expect(helpHostRoutes({ SERVICE_DOMAIN: 'www.mocco.club' })).toEqual({ rewrites: [], redirects: [] });
  });

  it("mounts HELP_APP_HOST_SITE's /feedback pages on the app host, and only those paths", () => {
    const { rewrites } = helpHostRoutes(mounted);

    expect(rewrites.slice(0, -1)).toEqual(helpHostRoutes(today).rewrites);
    expect(rewrites.at(-1)).toEqual({
      source: '/feedback/:path*',
      has: [{ type: 'host', value: String.raw`^www\.mocco\.club$` }],
      destination: '/_sites/mocco/feedback/:path*',
    });
  });

  it("sends the site's own hosts' /feedback pages to the app host for good (308)", () => {
    expect(helpHostRoutes(mounted).redirects).toEqual([
      {
        source: '/feedback/:path*',
        has: [{ type: 'host', value: String.raw`^mocco\.help\.mocco\.club$` }],
        destination: 'https://www.mocco.club/feedback/:path*',
        permanent: true,
      },
      {
        source: '/feedback/:path*',
        has: [{ type: 'host', value: String.raw`^docs\.mocco\.club$` }],
        destination: 'https://www.mocco.club/feedback/:path*',
        permanent: true,
      },
    ]);
  });

  it('matches the app host without its port, and redirects to it with the port', () => {
    const routes = helpHostRoutes({
      SERVICE_DOMAIN: 'localhost:3326',
      HELP_SITES_DOMAIN: 'help.localhost:3326',
      HELP_APP_HOST_SITE: 'mocco',
    });

    expect(routes.rewrites.at(-1)?.has).toEqual([{ type: 'host', value: '^localhost$' }]);
    expect(routes.redirects).toEqual([
      {
        source: '/feedback/:path*',
        has: [{ type: 'host', value: String.raw`^mocco\.help\.localhost$` }],
        destination: 'http://localhost:3326/feedback/:path*',
        permanent: true,
      },
    ]);
  });

  it('mounts nothing without SERVICE_DOMAIN (a preview), as today', () => {
    const preview = { HELP_SITES_DOMAIN: today.HELP_SITES_DOMAIN, HELP_CUSTOM_DOMAINS: today.HELP_CUSTOM_DOMAINS };

    expect(helpHostRoutes({ ...preview, HELP_APP_HOST_SITE: 'mocco' })).toEqual(helpHostRoutes(preview));
  });
});
