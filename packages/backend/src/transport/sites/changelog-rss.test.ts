import { describe, expect, it } from 'vitest';

import { changelogPlainText, changelogRss, RSS_DESCRIPTION_MAX } from '@backend/transport/sites/changelog-rss';

import type { FeedbackV1ChangelogEntry } from '@mocco/common/feedback-v1';

const entry = (fields: Partial<FeedbackV1ChangelogEntry> & { slug: string }): FeedbackV1ChangelogEntry => ({
  id: '00000000-0000-4000-8000-000000000001',
  title: 'Dark mode',
  body: '',
  tags: [],
  publishedAt: '2026-10-16T09:00:00.000Z',
  posts: [],
  ...fields,
});

const feed = (entries: FeedbackV1ChangelogEntry[]) =>
  changelogRss({
    origin: 'https://help.acme.app',
    siteName: 'Acme & Co',
    board: { slug: 'ideas', name: 'Ideas' },
    entries,
  });

describe('changelog RSS', () => {
  it('is RSS 2.0 with a self link, and an item per entry with a permalink guid and an RFC 822 date', () => {
    const xml = feed([
      entry({ slug: 'dark-mode', tags: ['new', 'improved'], body: 'Turn it on in **Settings**.' }),
      entry({ slug: 'older', title: 'Older', publishedAt: '2026-09-01T00:00:00.000Z' }),
    ]);
    expect(xml).toMatch(
      /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<rss version="2\.0" xmlns:atom="http:\/\/www\.w3\.org\/2005\/Atom">/u,
    );
    expect(xml).toContain('<title>Ideas changelog · Acme &amp; Co</title>');
    expect(xml).toContain('<link>https://help.acme.app/feedback/ideas/changelog</link>');
    expect(xml).toContain(
      '<atom:link href="https://help.acme.app/feedback/ideas/changelog.rss" rel="self" type="application/rss+xml"/>',
    );
    expect(xml).toContain('<lastBuildDate>Fri, 16 Oct 2026 09:00:00 GMT</lastBuildDate>');
    expect(xml).toContain(
      [
        '    <item>',
        '      <title>Dark mode</title>',
        '      <link>https://help.acme.app/feedback/ideas/changelog/dark-mode</link>',
        '      <guid isPermaLink="true">https://help.acme.app/feedback/ideas/changelog/dark-mode</guid>',
        '      <pubDate>Fri, 16 Oct 2026 09:00:00 GMT</pubDate>',
        '      <category>new</category>',
        '      <category>improved</category>',
        '      <description>Turn it on in Settings.</description>',
        '    </item>',
      ].join('\n'),
    );
    expect(xml.match(/<item>/gu)).toHaveLength(2);
  });

  it('has no items and no build date when nothing is published', () => {
    const xml = feed([]);
    expect(xml).not.toContain('<item>');
    expect(xml).not.toContain('lastBuildDate');
    expect(xml).toContain('</channel>\n</rss>\n');
  });

  it('carries no markup from an entry: HTML, scripts and link targets are dropped or escaped', () => {
    const xml = feed([
      entry({
        slug: 'xss',
        title: '<img src=x onerror=alert(1)>',
        body: [
          '<script>alert(1)</script>',
          '',
          '[Click](javascript:alert(1)) and ![pic](https://evil.test/p.png "t")',
          '',
          '```html',
          '<b>code</b>',
          '```',
          '',
          '> Quote with <em>tags</em> & "quotes"',
        ].join('\n'),
      }),
    ]);
    expect(xml).not.toMatch(/<script|<img|<em>|<b>|javascript:|onerror=alert\(1\)>/u);
    expect(xml).toContain('<title>&lt;img src=x onerror=alert(1)&gt;</title>');
    expect(xml).toContain('<description>Click and pic\nQuote with tags &amp; &quot;quotes&quot;</description>');
  });

  it('keeps an item description short', () => {
    const text = changelogPlainText('word '.repeat(1000));
    expect(text).toHaveLength(RSS_DESCRIPTION_MAX);
    expect(text.endsWith('…')).toBe(true);
  });
});
