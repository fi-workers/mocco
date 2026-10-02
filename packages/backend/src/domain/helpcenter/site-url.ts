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
