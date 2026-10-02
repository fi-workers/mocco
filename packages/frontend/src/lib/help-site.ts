// Server-side data for the public help center pages (pages/_sites/**): reads the published
// site through the backend's public-read service and turns article Markdown into the
// render tree. Only getStaticProps calls it; nothing here reaches the browser bundle.
import { getHelpDomain } from '@mocco/backend/helpcenter/instance';

import { markdownToBlocks } from '@frontend/lib/markdown-blocks';

import type { DocBlock } from '@frontend/lib/doc-ast';

export interface HelpSiteNav {
  slug: string;
  name: string;
  locale: string;
  locales: string[];
  collections: {
    slug: string;
    title: string;
    sections: { title: string; articles: { title: string; path: string }[] }[];
  }[];
}

/** Pages regenerate at most this often after a request (ISR). */
export const HELP_REVALIDATE_SECONDS = 60;

/** A missing site is a 404, not a build error. */
const isMissingSite = (error: unknown) => error instanceof Error && error.name === 'HelpSiteNotFoundError';

/** The site and its published tree in `locale`, or undefined when there is no such site. */
export async function loadHelpNav(site: string, locale: string): Promise<HelpSiteNav | undefined> {
  const { helpPublic } = getHelpDomain();
  try {
    const info = await helpPublic.site(site);
    const tree = await helpPublic.tree(site, locale);
    return {
      slug: info.slug,
      name: info.name,
      locale: tree.locale,
      locales: [info.sourceLocale, ...info.locales],
      collections: tree.collections.map(collection => ({
        slug: collection.slug,
        title: collection.title,
        sections: collection.sections.map(section => ({
          title: section.title,
          articles: section.articles.map(article => ({ title: article.title, path: article.path })),
        })),
      })),
    };
  } catch (error) {
    if (isMissingSite(error)) {
      return undefined;
    }
    throw error;
  }
}

/** Links an article may carry: http(s) and mailto open as external, site paths and anchors stay. */
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

export async function loadHelpArticle(site: string, locale: string, ref: string) {
  const { helpPublic } = getHelpDomain();
  try {
    const article = await helpPublic.article(site, locale, ref);
    if (article === undefined) {
      return undefined;
    }
    const blocks: DocBlock[] = markdownToBlocks(article.body, {
      link: articleLink,
      image: (href, alt) => (/^https:\/\//u.test(href) ? { t: 'image', src: href, alt } : null),
    });
    return {
      title: article.title,
      locale: article.locale,
      canonicalPath: article.canonicalPath,
      publishedAt: article.publishedAt?.toISOString() ?? null,
      blocks,
    };
  } catch (error) {
    if (isMissingSite(error)) {
      return undefined;
    }
    throw error;
  }
}
