// robots.txt bodies (#363). Every crawler may read the public pages — search and AI
// crawlers alike — except the paths listed, and is pointed at the sitemap. `blocked`
// user agents get a group of their own that disallows everything; a crawler follows the
// most specific group naming it, so the `*` group no longer applies to them.

/**
 * The crawlers AI companies use to collect training data, as each documents its user agent.
 * Their search and user-triggered fetchers (OAI-SearchBot, ChatGPT-User, Claude-SearchBot,
 * Claude-User, PerplexityBot) are separate agents and stay allowed.
 */
export const AI_TRAINING_CRAWLERS = [
  'GPTBot',
  'ClaudeBot',
  'Google-Extended',
  'Applebot-Extended',
  'CCBot',
  'meta-externalagent',
  'Bytespider',
] as const;

export function robotsTxt(opts: { disallow: readonly string[]; sitemap: string; blocked?: readonly string[] }): string {
  const blocked = opts.blocked ?? [];
  return [
    'User-agent: *',
    'Allow: /',
    ...opts.disallow.map(path => `Disallow: ${path}`),
    '',
    ...(blocked.length === 0 ? [] : [...blocked.map(agent => `User-agent: ${agent}`), 'Disallow: /', '']),
    `Sitemap: ${opts.sitemap}`,
    '',
  ].join('\n');
}
