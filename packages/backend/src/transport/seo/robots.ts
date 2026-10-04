// robots.txt bodies (#363). Every crawler may read the public pages — search and AI
// crawlers alike — except the paths listed, and is pointed at the sitemap.

export function robotsTxt(opts: { disallow: readonly string[]; sitemap: string }): string {
  return [
    'User-agent: *',
    'Allow: /',
    ...opts.disallow.map(path => `Disallow: ${path}`),
    '',
    `Sitemap: ${opts.sitemap}`,
    '',
  ].join('\n');
}
