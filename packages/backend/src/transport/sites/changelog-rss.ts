// A public board's changelog as RSS 2.0 (#176), at /feedback/<board>/changelog.rss on the help
// site's host. Pure over its inputs: the route binds the site and its entries. Item descriptions
// are the entry's text with the Markdown taken out (no HTML at all), escaped like every other
// value, so nothing an entry says can run in a feed reader.
import { parseMarkdown } from '@backend/domain/helpcenter/markdown/tree';

import type { FeedbackV1ChangelogEntry } from '@mocco/common/feedback-v1';
import type { Nodes } from 'mdast';

/** How much of an entry's text an item's description carries. */
export const RSS_DESCRIPTION_MAX = 1000;

const escapeXml = (text: string) =>
  // eslint-disable-next-line sonarjs/null-dereference -- text is a string, never null
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');

/** The words of a Markdown tree: text and inline code, an image's alt text; blocks on lines of their own. */
function plainText(node: Nodes): string {
  if (node.type === 'text' || node.type === 'inlineCode') {
    return node.value;
  }
  if (node.type === 'image') {
    return node.alt ?? '';
  }
  if (node.type === 'html' || node.type === 'code' || !('children' in node)) {
    return '';
  }
  const parts = (node.children as Nodes[]).map(child => plainText(child));
  const isBlock = ['root', 'list', 'blockquote', 'listItem'].includes(node.type);
  return parts.join(isBlock ? '\n' : '');
}

/** An entry's text without Markdown, at most RSS_DESCRIPTION_MAX characters. */
export function changelogPlainText(markdown: string): string {
  /* eslint-disable sonarjs/null-dereference -- the text and its lines are strings, never null */
  const text = plainText(parseMarkdown(markdown))
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
    .join('\n');
  return text.length > RSS_DESCRIPTION_MAX ? `${text.slice(0, RSS_DESCRIPTION_MAX - 1)}…` : text;
  /* eslint-enable sonarjs/null-dereference */
}

export interface ChangelogFeed {
  /** The site's canonical origin (its custom domain or subdomain). */
  origin: string;
  siteName: string;
  board: { slug: string; name: string };
  /** Published entries, newest first. */
  entries: readonly FeedbackV1ChangelogEntry[];
}

export function changelogRss(feed: ChangelogFeed): string {
  const page = `${feed.origin}/feedback/${feed.board.slug}/changelog`;
  const newest = feed.entries[0];
  const title = `${feed.board.name} changelog · ${feed.siteName}`;
  const description = `What's new in ${feed.board.name}, from ${feed.siteName}.`;
  const self = `${page}.rss`;
  const items = feed.entries.map(entry => {
    const link = `${page}/${entry.slug}`;
    return [
      '    <item>',
      `      <title>${escapeXml(entry.title)}</title>`,
      `      <link>${escapeXml(link)}</link>`,
      `      <guid isPermaLink="true">${escapeXml(link)}</guid>`,
      `      <pubDate>${new Date(entry.publishedAt).toUTCString()}</pubDate>`,
      ...entry.tags.map(tag => `      <category>${escapeXml(tag)}</category>`),
      `      <description>${escapeXml(changelogPlainText(entry.body))}</description>`,
      '    </item>',
    ].join('\n');
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '  <channel>',
    `    <title>${escapeXml(title)}</title>`,
    `    <link>${escapeXml(page)}</link>`,
    `    <description>${escapeXml(description)}</description>`,
    `    <atom:link href="${escapeXml(self)}" rel="self" type="application/rss+xml"/>`,
    ...(newest === undefined
      ? []
      : [`    <lastBuildDate>${new Date(newest.publishedAt).toUTCString()}</lastBuildDate>`]),
    ...items,
    '  </channel>',
    '</rss>',
    '',
  ].join('\n');
}
