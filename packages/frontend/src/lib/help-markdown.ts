// How a help article's Markdown resolves links and images, for the public pages (server)
// and the editor's preview (browser) alike.
import { markdownToBlocks } from '@frontend/lib/markdown-blocks';

import type { DocBlock } from '@frontend/lib/doc-ast';

/** http(s) and mailto open as external links; site paths and anchors stay; anything else drops the link. */
// eslint-disable-next-line sonarjs/function-return-type -- null drops the link, as MarkdownResolvers defines
function articleLink(href: string): { href: string; external: boolean } | null {
  if (/^(?:https?:\/\/|mailto:)/u.test(href)) {
    return { href, external: true };
  }
  // eslint-disable-next-line sonarjs/null-dereference -- a link's href, never null
  if (href.startsWith('/') || href.startsWith('#')) {
    return { href, external: false };
  }
  return null;
}

export function helpArticleBlocks(markdown: string): DocBlock[] {
  return markdownToBlocks(markdown, {
    link: articleLink,
    // Absolute URLs only: storage serves imported images over http locally, https elsewhere.
    image: (href, alt) => (/^https?:\/\//u.test(href) ? { t: 'image', src: href, alt } : null),
  });
}
