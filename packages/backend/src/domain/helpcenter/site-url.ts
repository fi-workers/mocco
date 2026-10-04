// Where a help center is served, for absolute article URLs (in /v1 search answers): the
// customer domain HELP_CUSTOM_DOMAINS maps to the site, else <slug>.<HELP_SITES_DOMAIN>.
// The same variables drive next.config.ts's host rewrites.

/* eslint-disable sonarjs/null-dereference -- every value here is a string from a split, never null */

export function helpSiteOrigin(
  slug: string,
  env: { HELP_SITES_DOMAIN?: string; HELP_CUSTOM_DOMAINS?: string },
): string | null {
  const custom = (env.HELP_CUSTOM_DOMAINS ?? '')
    .split(',')
    .map(entry => entry.split('=', 2).map(part => part.trim()))
    .find(([, site]) => site === slug)?.[0];
  const host = custom ?? (env.HELP_SITES_DOMAIN === undefined ? undefined : `${slug}.${env.HELP_SITES_DOMAIN}`);
  if (host === undefined || host === '') {
    return null;
  }
  const isLocal = (host.split(':', 1)[0] ?? '').endsWith('localhost');
  return `${isLocal ? 'http' : 'https'}://${host}`;
}

/**
 * The site a request's host serves — a customer domain HELP_CUSTOM_DOMAINS maps, or
 * `<slug>.<HELP_SITES_DOMAIN>` — or null for any other host (the app itself). Ports are
 * ignored, as next.config.ts's host rewrites ignore them.
 */
export function helpSiteForHost(
  host: string,
  env: { HELP_SITES_DOMAIN?: string; HELP_CUSTOM_DOMAINS?: string },
): string | null {
  const hostname = (host.split(':', 1)[0] ?? '').toLowerCase();
  if (hostname === '') {
    return null;
  }
  const custom = (env.HELP_CUSTOM_DOMAINS ?? '')
    .split(',')
    .map(entry => entry.split('=', 2).map(part => part.trim()))
    .find(([domain]) => (domain?.split(':', 1)[0] ?? '').toLowerCase() === hostname)?.[1];
  if (custom !== undefined && /^[a-z0-9-]+$/u.test(custom)) {
    return custom;
  }
  const sitesDomain = (env.HELP_SITES_DOMAIN?.split(':', 1)[0] ?? '').toLowerCase();
  if (sitesDomain === '' || !hostname.endsWith(`.${sitesDomain}`)) {
    return null;
  }
  const slug = hostname.slice(0, -(sitesDomain.length + 1));
  return /^[a-z0-9-]+$/u.test(slug) ? slug : null;
}
