// Which host serves a help site's pages (ADR 0015), as pure functions of the env: next.config.ts
// builds its host rewrites and redirects from them at build time, the backend computes a site's
// public origin from them, and the console links a site's boards with them.
//
// A site is served on `<slug>.<HELP_SITES_DOMAIN>` and on any custom domain HELP_CUSTOM_DOMAINS
// maps to it. HELP_APP_HOST_SITE names one site whose /feedback pages (board, roadmap, posts,
// changelog and its feed) are served on the app's own host, SERVICE_DOMAIN, instead: Mocco's own
// board at www.mocco.club/feedback/<board>, beside /docs, so search credits one domain. Its other
// hosts redirect /feedback/* there, so each page has one URL. The site's help center pages stay on
// its own hosts. Nothing here imports anything: next.config.ts loads this file as it is.

/* eslint-disable sonarjs/null-dereference -- every value here is a string from a split, never null */

export interface HelpHostEnv {
  /** The app's canonical host, e.g. `www.mocco.club` (a bare authority, no scheme). */
  SERVICE_DOMAIN?: string;
  /** The parent of each site's own subdomain, e.g. `help.mocco.club`. */
  HELP_SITES_DOMAIN?: string;
  /** `help.example.com=<slug>,…`: customer domains, each serving one site. */
  HELP_CUSTOM_DOMAINS?: string;
  /** The slug of the site whose /feedback pages the app's own host serves. */
  HELP_APP_HOST_SITE?: string;
}

/** Where a site's pages live under the app's host when it is mounted there. */
export const APP_HOST_SITE_PREFIX = '/feedback';

const SITE_SLUG = /^[a-z0-9-]+$/u;

/** A domain's hostname: Next matches `host` conditions against it, without the port. */
export const hostnameOf = (domain: string | undefined): string => (domain ?? '').trim().split(':', 1)[0] ?? '';

/** A hostname with its dots escaped, for a regex. */
const escapeDots = (hostname: string) => hostname.replaceAll('.', String.raw`\.`);
/** A hostname as an exact-match regex for a Next `host` condition. */
const hostPattern = (hostname: string) => `^${escapeDots(hostname)}$`;

/** Loopback hosts (local dev) are plain http; every real host terminates TLS. */
export const originOfHost = (host: string): string => {
  const hostname = hostnameOf(host).toLowerCase();
  const isLocal = hostname === 'localhost' || hostname.endsWith('.localhost');
  return `${isLocal ? 'http' : 'https'}://${host.trim()}`;
};

/** HELP_CUSTOM_DOMAINS as `{ domain, site }` pairs, skipping malformed entries. */
export function helpCustomDomainsOf(env: HelpHostEnv): { domain: string; site: string }[] {
  return (env.HELP_CUSTOM_DOMAINS ?? '').split(',').flatMap(entry => {
    const [domain = '', site = ''] = entry.split('=', 2).map(part => part.trim());
    return hostnameOf(domain) === '' || !SITE_SLUG.test(site) ? [] : [{ domain, site }];
  });
}

/**
 * The site whose /feedback pages the app's own host serves, or null. Needs SERVICE_DOMAIN: the
 * mount is on that host only, so a deployment without it (a preview) serves the site as before.
 */
export function appHostSiteOf(env: HelpHostEnv): string | null {
  const slug = (env.HELP_APP_HOST_SITE ?? '').trim();
  return slug !== '' && SITE_SLUG.test(slug) && hostnameOf(env.SERVICE_DOMAIN) !== '' ? slug : null;
}

/** The app host's origin when it serves `slug`'s /feedback pages, else null. */
export function appHostOriginFor(slug: string, env: HelpHostEnv): string | null {
  return appHostSiteOf(env) === slug && env.SERVICE_DOMAIN !== undefined ? originOfHost(env.SERVICE_DOMAIN) : null;
}

interface HostCondition {
  type: 'host';
  value: string;
}

export interface HelpHostRewrite {
  source: string;
  destination: string;
  has: HostCondition[];
}

export interface HelpHostRedirect {
  source: string;
  destination: string;
  permanent: true;
  has: HostCondition[];
}

/** A site's own subdomain, `<slug>.`, captured as `site`; the sites domain follows. */
const SITE_SUBDOMAIN = String.raw`^(?<site>[a-z0-9-]+)\.`;
/** Everything on a help site's host but Next's own assets and the API routes. */
const SITE_PATHS = '/:path((?!_next/|api/|favicon).*)';

/**
 * The host rewrites and redirects that serve help sites, for next.config.ts:
 * - `<slug>.<HELP_SITES_DOMAIN>/*` and each custom domain's `/*` → `pages/_sites/<slug>/*`;
 * - with HELP_APP_HOST_SITE, the app host's `/feedback/*` → `pages/_sites/<that site>/feedback/*`
 *   (no other path on the app host changes), and that site's own hosts redirect `/feedback/*`
 *   to the app host (308), so search sees one URL per page.
 */
export function helpHostRoutes(env: HelpHostEnv): { rewrites: HelpHostRewrite[]; redirects: HelpHostRedirect[] } {
  const sitesHostname = hostnameOf(env.HELP_SITES_DOMAIN).toLowerCase();
  const customDomains = helpCustomDomainsOf(env);
  const rewrites: HelpHostRewrite[] = [
    ...(sitesHostname === ''
      ? []
      : [
          {
            source: SITE_PATHS,
            has: [
              {
                type: 'host' as const,
                value: `${SITE_SUBDOMAIN}${escapeDots(sitesHostname)}$`,
              },
            ],
            destination: '/_sites/:site/:path',
          },
        ]),
    ...customDomains.map(({ domain, site }) => ({
      source: SITE_PATHS,
      has: [{ type: 'host' as const, value: hostPattern(hostnameOf(domain).toLowerCase()) }],
      destination: `/_sites/${site}/:path`,
    })),
  ];
  const site = appHostSiteOf(env);
  const appOrigin = site === null ? null : appHostOriginFor(site, env);
  if (site === null || appOrigin === null) {
    return { rewrites, redirects: [] };
  }
  const appHostname = hostnameOf(env.SERVICE_DOMAIN).toLowerCase();
  const siteHostnames = [
    ...(sitesHostname === '' ? [] : [`${site}.${sitesHostname}`]),
    ...customDomains.filter(entry => entry.site === site).map(entry => hostnameOf(entry.domain).toLowerCase()),
  ].filter(hostname => hostname !== appHostname);
  return {
    rewrites: [
      ...rewrites,
      {
        source: `${APP_HOST_SITE_PREFIX}/:path*`,
        has: [{ type: 'host', value: hostPattern(appHostname) }],
        destination: `/_sites/${site}${APP_HOST_SITE_PREFIX}/:path*`,
      },
    ],
    redirects: siteHostnames.map(hostname => ({
      source: `${APP_HOST_SITE_PREFIX}/:path*`,
      has: [{ type: 'host', value: hostPattern(hostname) }],
      destination: `${appOrigin}${APP_HOST_SITE_PREFIX}/:path*`,
      permanent: true,
    })),
  };
}
